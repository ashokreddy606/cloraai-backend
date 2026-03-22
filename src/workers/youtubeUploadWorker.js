const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { notifyPostSuccess, notifyPostFailure } = require('../services/pushNotificationService');
const { generatePresignedUrl } = require('../config/s3Utils');
const { google } = require('googleapis');
const { getYoutubeOAuth2Client } = require('../config/youtube');
const { decrypt, encrypt } = require('../utils/cryptoUtils');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper to get an authenticated YouTube client for a user, with token refresh
const getYoutubeClientForWorker = async (user) => {
    const client = getYoutubeOAuth2Client();
    const credentials = {
        access_token: decrypt(user.youtubeAccessToken)
    };
    if (user.youtubeRefreshToken) {
        credentials.refresh_token = decrypt(user.youtubeRefreshToken);
    }
    client.setCredentials(credentials);

    try {
        const { token } = await client.getAccessToken();
        if (token && token !== credentials.access_token) {
            await prisma.user.update({
                where: { id: user.id },
                data: { youtubeAccessToken: encrypt(token) }
            });
        }
    } catch (err) {
        logger.error('WORKER:YT', 'Token refresh failed', { userId: user.id, error: err.message });
    }

    return google.youtube({ version: 'v3', auth: client });
};

const processYoutubeUpload = async (job) => {
    const { postId } = job.data;
    let post;
    let tempFilePath = null;
    
    try {
        post = await prisma.scheduledPost.findUnique({
            where: { id: postId },
            include: { user: true }
        });

        if (!post) {
            logger.warn('WORKER:YT', `Post ${postId} not found.`);
            return;
        }

        if (post.status !== 'publishing' && post.status !== 'IN_PROGRESS') {
            logger.info('WORKER:YT', `Post ${postId} status is ${post.status}, skipping.`);
            return;
        }

        if (!post.user.youtubeAccessToken || !post.user.youtubeRefreshToken) {
            throw new Error('YouTube account not connected.');
        }

        // 1. Generate a temporary pre-signed URL so we can download the private S3 file
        let mediaUrlForDownload = post.mediaUrl;
        if (post.mediaUrl.includes('amazonaws.com') || post.mediaUrl.includes('s3')) {
            mediaUrlForDownload = await generatePresignedUrl(post.mediaUrl, 3600);
            logger.info('WORKER:YT_S3', 'Generated pre-signed URL for local download');
        }

        // 2. Download video from S3 URL to temp file
        const tempDir = path.join(os.tmpdir(), 'cloraai-worker-uploads');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        
        const fileName = `post_${post.id}_${Date.now()}.mp4`;
        tempFilePath = path.join(tempDir, fileName);
        
        logger.info('WORKER:YT_DOWNLOAD', `Downloading video for post ${post.id}...`);
        const response = await axios({
            method: 'get',
            url: mediaUrlForDownload,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 3. Upload to YouTube
        const youtube = await getYoutubeClientForWorker(post.user);
        logger.info('WORKER:YT_API', `Uploading to YouTube for user ${post.userId}`);
        
        const uploadRes = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: post.title || post.caption.substring(0, 100),
                    description: post.caption,
                    categoryId: '22',
                },
                status: {
                    privacyStatus: 'public',
                },
            },
            media: {
                body: fs.createReadStream(tempFilePath),
            },
        });

        const videoId = uploadRes.data.id;
        logger.info('WORKER:YT_SUCCESS', `Published! YouTube Video ID: ${videoId}`);

        // 4. Update DB
        await prisma.scheduledPost.update({
            where: { id: post.id },
            data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                youtubeVideoId: videoId,
                errorMessage: null
            }
        });

        // 5. Success Notification
        const user = await prisma.user.findUnique({ where: { id: post.userId }, select: { pushToken: true } });
        if (user?.pushToken) {
            await notifyPostSuccess(user.pushToken, post.caption?.substring(0, 40) || 'Your YouTube Short');
        }

        return { success: true, videoId };

    } catch (error) {
        logger.error('WORKER:YT_FAILED', 'YouTube job failed', { postId, error: error.message });
        
        if (postId) {
            await prisma.scheduledPost.update({
                where: { id: postId },
                data: {
                    status: 'FAILED',
                    errorMessage: error.message
                }
            }).catch(e => logger.error('WORKER:YT', 'Failed to update post status', { error: e.message }));
        }

        throw error;
    } finally {
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlink(tempFilePath, (err) => {
                if (err) logger.warn('WORKER:YT', 'Failed to delete temp file', { tempFilePath, error: err.message });
            });
        }
    }
};

module.exports = {
    processYoutubeUpload
};
