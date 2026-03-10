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
    // Step A: Create media container
    const axios = require('axios');
    const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v18.0';

    const containerRes = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.instagramId}/media`,
        null,
        {
            params: {
                image_url: post.mediaUrl,
                caption: post.caption,
                access_token: accessToken
            }
        }
    );

    const containerId = containerRes.data.id;
    if (!containerId) throw new Error('Failed to create Instagram media container');

    // Optional: wait for container to be ready (Instagram recommends polling)
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step B: Publish the container
    await axios.post(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.instagramId}/media_publish`,
        null,
        {
            params: {
                creation_id: containerId,
                access_token: accessToken
            }
        }
    );

    // 5. Mark post as PUBLISHED
    await prisma.scheduledPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHED', publishedAt: new Date() }
    });

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
                data: { status: 'FAILED', failureReason: err.message }
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
