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
const { generatePresignedUrl } = require('../config/s3Utils');

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

    if (!accessToken) {
        throw new Error('Failed to decrypt Instagram access token');
    }

    // 4. Publish via Instagram Graph API
    const axios = require('axios');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

    // 4a. Generate a temporary pre-signed URL so Instagram can access the private S3 file
    let mediaUrlForInstagram = post.mediaUrl;
    
    if (post.mediaUrl.includes('amazonaws.com') || post.mediaUrl.includes('s3')) {
        mediaUrlForInstagram = await generatePresignedUrl(post.mediaUrl, 3600);
        logger.info('WORKER:S3_SIGNED_URL', 'Generated pre-signed URL (if applicable)');
    }

    logger.info('WORKER:META_API_START', `Creating media container for post ${postId}`, { 
        mediaUrl: mediaUrlForInstagram.substring(0, 100) + '...',
        instagramId: account.instagramId,
        accessTokenPrefix: accessToken.substring(0, 10)
    });
    
    // Step A: Create media container
    let containerRes;
    try {
        containerRes = await axios.post(
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
    } catch (apiErr) {
        const errorData = apiErr.response?.data || apiErr.message;
        logger.error('WORKER:META_API_A_FAILED', 'Step A: Container creation failed', { 
            error: errorData,
            status: apiErr.response?.status
        });
        throw new Error(`Instagram Step A Failed: ${JSON.stringify(errorData)}`);
    }

    const containerId = containerRes.data.id;
    if (!containerId) {
        logger.error('WORKER:META_API_A_EMPTY', 'Step A: No container ID returned', { response: containerRes.data });
        throw new Error('Failed to create Instagram media container (No ID)');
    }

    logger.info('WORKER:META_API_A_SUCCESS', `Container created: ${containerId}. Waiting for processing...`);

    // Step B: Poll for container status
    // Reels take time to process. We MUST poll for 'FINISHED' status before publishing.
    let status = 'IN_PROGRESS';
    let attempts = 0;
    const maxAttempts = 20; // 20s * 20 = 400s (~6.6 mins)
    
    while (status !== 'FINISHED' && status !== 'READY' && attempts < maxAttempts) {
        attempts++;
        logger.info('WORKER:META_API_B_POLL', `Polling container status (Attempt ${attempts}/${maxAttempts})...`, { containerId });
        
        // Wait before first poll and between polls
        await new Promise(resolve => setTimeout(resolve, 20000));
        
        try {
            const statusRes = await axios.get(
                `https://graph.facebook.com/${META_GRAPH_VERSION}/${containerId}`,
                {
                    params: {
                        fields: 'status_code,status',
                        access_token: accessToken
                    }
                }
            );
            
            // Meta returns status_code in newer versions, status in older
            status = statusRes.data.status_code || statusRes.data.status;
            logger.info('WORKER:META_API_B_STATUS', `Status: ${status}`, { containerId });
            
            if (status === 'FINISHED' || status === 'READY') break;
            
            if (status === 'ERROR' || status === 'EXPIRED') {
                const errorMsg = statusRes.data.error_message || 'Unknown processing error';
                throw new Error(`Instagram Processing Failed: ${errorMsg}`);
            }
        } catch (pollErr) {
            // If we've hit an error but have attempts left, we keep going (network blips)
            // Unless it's an explicit "Instagram Processing Failed" from above
            if (pollErr.message.includes('Instagram Processing Failed')) throw pollErr;
            
            logger.warn('WORKER:META_API_B_WARN', 'Status poll failed, will retry', { 
                error: pollErr.message,
                attempt: attempts 
            });
        }
    }
    
    if (status !== 'FINISHED' && status !== 'READY') {
        throw new Error(`Media processing timeout. Status is still ${status} after 6+ minutes.`);
    }

    // Step C: Publish the container
    logger.info('WORKER:META_API_C_START', `Publishing container ${containerId}`);
    let publishRes;
    try {
        publishRes = await axios.post(
            `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.instagramId}/media_publish`,
            {
                creation_id: containerId
            },
            {
                params: { access_token: accessToken }
            }
        );
    } catch (apiErr) {
        const errorData = apiErr.response?.data || apiErr.message;
        logger.error('WORKER:META_API_C_FAILED', 'Step C: Publication failed', { 
            error: errorData,
            status: apiErr.response?.status
        });
        throw new Error(`Instagram Step C Failed: ${JSON.stringify(errorData)}`);
    }

    const instagramPostId = publishRes.data.id;
    if (!instagramPostId) {
        logger.error('WORKER:META_API_C_EMPTY', 'Step C: No post ID returned', { response: publishRes.data });
        throw new Error('Failed to publish Instagram media container (No ID)');
    }

    // 5. Mark post as PUBLISHED
    await prisma.scheduledPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHED', publishedAt: new Date(), instagramPostId }
    });

    // 5. Link/Create DM Automation rule if post has automation data
    if (post.automationKeyword && post.automationReply) {
        try {
            logger.info('WORKER:IG_RULE', `Creating DM Automation rule for reel ${instagramPostId}`, {
                keyword: post.automationKeyword,
                triggerType: post.triggerType,
                replyType: post.replyType
            });

            const links = post.automationLinks ? post.automationLinks.split(',').map(l => l.trim()) : [];
            
            await prisma.dMAutomation.create({
                data: {
                    userId,
                    keyword: post.automationKeyword.toLowerCase(),
                    autoReplyMessage: post.automationReply,
                    isActive: true,
                    reelId: instagramPostId,
                    appendLinks: post.automationAppendLinks || false,
                    link1: links[0] || null,
                    link2: links[1] || null,
                    link3: links[2] || null,
                    link4: links[3] || null,
                    isAI: post.isAI || false,
                    triggerType: post.triggerType || 'keywords',
                    replyType: post.replyType || 'text',
                    productName: post.productName || null,
                    productUrl: post.productUrl || null,
                    productDescription: post.productDescription || null,
                    productImage: post.productImage || null,
                    mustFollow: post.mustFollow || false,
                    dmButtonText: post.dmButtonText || null,
                    publicReplies: post.publicReplies || null,
                    customFollowEnabled: post.customFollowEnabled || false,
                    customFollowHeader: post.customFollowHeader || null,
                    customFollowSubtext: post.customFollowSubtext || null,
                    followButtonText: post.followButtonText || null,
                    followedButtonText: post.followedButtonText || null,
                    dmReplyEnabled: post.dmReplyEnabled || false
                }
            });
            logger.info('WORKER:IG_RULE_SUCCESS', `DM Automation rule linked to reel ${instagramPostId}`);
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

module.exports = {
    processScheduledPost
};
