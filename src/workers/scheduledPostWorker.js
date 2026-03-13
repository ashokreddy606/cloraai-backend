/**
 * Scheduled Post Worker — BullMQ Worker
 * 
 * Processes jobs from the 'instagram-publish' queue.
 * 
 * Retry policy: 3 attempts with exponential backoff.
 * Dead-letter: failed jobs are logged and DB status updated to FAILED.
 * On success: sends push notification to user if push token exists.
 */
const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { notifyPostSuccess, notifyPostFailure } = require('../services/pushNotificationService');

const processScheduledPost = async (job) => {
    const { postId, userId } = job.data;
    logger.info('WORKER', `Processing scheduled post job ${job.id}`, { postId, userId });

    // 1. Load the post from DB
    const post = await prisma.scheduledPost.findUnique({ where: { id: postId } });
    if (!post) {
        throw new Error(`ScheduledPost ${postId} not found — may have been deleted`);
    }

    if (post.status === 'PUBLISHED') {
        logger.info('WORKER', `Post ${postId} already published — skipping`);
        return { skipped: true };
    }

    // 2. Mark as IN_PROGRESS
    await prisma.scheduledPost.update({
        where: { id: postId },
        data: { status: 'IN_PROGRESS' }
    });

    // 3. Get user's Instagram access token
    const account = await prisma.instagramAccount.findUnique({ where: { userId } });
    if (!account || !account.instagramAccessToken) {
        throw new Error('Instagram account not connected for this user');
    }

    const { decryptToken } = require('../utils/cryptoUtils');
    const accessToken = decryptToken(account.instagramAccessToken);

    // 4. Publish via Instagram Graph API
    const axios = require('axios');
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

    // 4a. Generate a temporary pre-signed URL so Instagram can access the private S3 file
    let mediaUrlForInstagram = post.mediaUrl;
    
    if (post.mediaUrl.includes('amazonaws.com')) {
        try {
            const s3Client = new S3Client({
                region: process.env.AWS_REGION || 'ap-south-2',
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }
            });

            // Extract key from URL: https://bucket.s3.region.amazonaws.com/key
            const urlParts = new URL(post.mediaUrl);
            const key = urlParts.pathname.substring(1); // Remove leading slash
            const bucket = urlParts.hostname.split('.')[0];

            logger.info('WORKER:S3_SIGNED_URL', `Generating signed URL for key: ${key} in bucket: ${bucket}`);
            
            const command = new GetObjectCommand({ Bucket: bucket, Key: key });
            mediaUrlForInstagram = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
            
            logger.info('WORKER:S3_SIGNED_URL_SUCCESS', 'Generated pre-signed URL for Instagram');
        } catch (s3Err) {
            logger.error('WORKER:S3_SIGNED_URL_ERROR', 'Failed to generate signed URL', { error: s3Err.message });
            // Fallback to original URL
        }
    }

    logger.info('WORKER:META_API', `Creating media container for post ${postId}`, { original_url: post.mediaUrl });
    
    // Step A: Create media container
    const containerRes = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.instagramId}/media`,
        {
            video_url: mediaUrlForInstagram,
            caption: post.caption,
            media_type: 'REELS'
        },
        {
            params: { access_token: accessToken }
        }
    );

    const containerId = containerRes.data.id;
    if (!containerId) {
        logger.error('WORKER:META_API_ERROR', 'Failed to create media container', { response: containerRes.data });
        throw new Error('Failed to create Instagram media container');
    }

    logger.info('WORKER:META_API', `Container created: ${containerId}. Waiting for processing...`);

    // Step B: Poll for container status or wait 
    // Reels take time to process. Let's wait longer or poll.
    // Simple approach: longer wait + retry logic (worker does 3 retries)
    await new Promise(resolve => setTimeout(resolve, 30000)); // Increase to 30s for Reels

    // Step C: Publish the container
    logger.info('WORKER:META_API', `Publishing container ${containerId}`);
    const publishRes = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.instagramId}/media_publish`,
        {
            creation_id: containerId
        },
        {
            params: { access_token: accessToken }
        }
    );

    const instagramPostId = publishRes.data.id;
    if (!instagramPostId) {
        logger.error('WORKER:META_API_ERROR', 'Failed to publish container', { response: publishRes.data });
        throw new Error('Failed to publish Instagram media container');
    }

    // 5. Mark post as PUBLISHED
    await prisma.scheduledPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHED', publishedAt: new Date(), instagramPostId }
    });

    // 5b. Create DM Automation rule if requested
    if (post.automationKeyword && post.automationReply && instagramPostId) {
        let links = [];
        if (post.automationLinks) {
            try {
                links = JSON.parse(post.automationLinks);
            } catch (e) {
                logger.warn('WORKER', `Failed to parse automationLinks for post ${postId}`);
            }
        }
        
        try {
            await prisma.dMAutomation.create({
                data: {
                    userId,
                    keyword: post.automationKeyword,
                    autoReplyMessage: post.automationReply,
                    isActive: true,
                    reelId: instagramPostId,
                    appendLinks: post.automationAppendLinks || false,
                    link1: links[0] || null,
                    link2: links[1] || null,
                    link3: links[2] || null,
                    link4: links[3] || null,
                }
            });
            logger.info('WORKER', `Created DM Automation rule for reel ${instagramPostId}`);
        } catch (ruleErr) {
            logger.error('WORKER', `Failed to create DM Automation rule for reel ${instagramPostId}`, { error: ruleErr.message });
        }
    }

    // 6. Send success push notification if user has push token
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pushToken: true } });
    if (user?.pushToken) {
        await notifyPostSuccess(user.pushToken, post.caption?.substring(0, 40) || 'Your post');
    }

    logger.info('WORKER', `Post ${postId} published successfully`);
    return { success: true, postId };
};

// Create the BullMQ Worker
const scheduledPostWorker = new Worker(
    QUEUES.INSTAGRAM,
    processScheduledPost,
    {
        connection,
        concurrency: 5, // process up to 5 posts simultaneously
        // Retry policy: 3 attempts with exponential backoff
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000,
            },
        },
    }
);

// Success event
scheduledPostWorker.on('completed', (job, result) => {
    logger.info('WORKER', `Job ${job.id} completed`, result);
});

// Failure event — dead-letter handling
scheduledPostWorker.on('failed', async (job, err) => {
    logger.error('WORKER', `Job ${job.id} failed permanently after ${job.attemptsMade} attempts`, {
        error: err.message,
        postId: job?.data?.postId,
        userId: job?.data?.userId,
    });

    // Mark post as permanently failed in DB
    if (job?.data?.postId) {
        try {
            await prisma.scheduledPost.update({
                where: { id: job.data.postId },
                data: { status: 'FAILED', errorMessage: err.message }
            });

            // Send failure push notification
            const user = await prisma.user.findUnique({
                where: { id: job.data.userId },
                select: { pushToken: true }
            });
            if (user?.pushToken) {
                const post = await prisma.scheduledPost.findUnique({ where: { id: job.data.postId } });
                await notifyPostFailure(
                    user.pushToken,
                    post?.caption?.substring(0, 40) || 'Your post',
                    err.message
                );
            }
        } catch (dbErr) {
            logger.error('WORKER', 'Failed to update post status after job failure', { error: dbErr.message });
        }
    }
});

scheduledPostWorker.on('error', (err) => {
    logger.error('WORKER', 'Worker encountered an error', { error: err.message });
});

logger.info('WORKER', '✅ Scheduled Post Worker initialized');

module.exports = scheduledPostWorker;
