const { Queue } = require('bullmq');
const { redisClient } = require('./cache');
const logger = require('./logger');

// Define connection for BullMQ
const connection = redisClient;

// Define Queues
const QUEUES = {
    AI_TASKS: 'ai-tasks',
    WEBHOOKS: 'webhooks',
    SUBSCRIPTIONS: 'subscriptions',
    INSTAGRAM: 'instagram-publish',
    YOUTUBE: 'youtube-upload',
    REPLY: 'reply-queue',
    COMMENT: 'instagramAutomationQueue',
    ANALYTICS: 'analytics-queue',
    TOKEN_REFRESH: 'token-refresh-queue',
    NOTIFICATIONS: 'notification-queue',
    AUTH: 'auth-queue'
};

// Initialize Queues safely
let aiQueue, webhookQueue, subscriptionQueue, instagramQueue, youtubeQueue, replyQueue, commentQueue, analyticsQueue, tokenRefreshQueue, notificationQueue, authQueue;

if (connection && !connection.isMock) {
    const queueOptions = { connection };
    aiQueue = new Queue(QUEUES.AI_TASKS, queueOptions);
    webhookQueue = new Queue(QUEUES.WEBHOOKS, queueOptions);
    subscriptionQueue = new Queue(QUEUES.SUBSCRIPTIONS, queueOptions);
    instagramQueue = new Queue(QUEUES.INSTAGRAM, queueOptions);
    youtubeQueue = new Queue(QUEUES.YOUTUBE, queueOptions);
    replyQueue = new Queue(QUEUES.REPLY, queueOptions);
    commentQueue = new Queue(QUEUES.COMMENT, queueOptions);
    analyticsQueue = new Queue(QUEUES.ANALYTICS, queueOptions);
    tokenRefreshQueue = new Queue(QUEUES.TOKEN_REFRESH, queueOptions);
    notificationQueue = new Queue(QUEUES.NOTIFICATIONS, queueOptions);
    authQueue = new Queue(QUEUES.AUTH, queueOptions);
} else {
    logger.warn('QUEUE', 'Redis connection missing. Queues are disabled (expected in local dev without Redis).');
}

// Helper function to add jobs with enhanced reliability
const enqueueJob = async (queue, jobName, data, options = {}) => {
    if (!queue) {
        logger.error('QUEUE', `CRITICAL: Queue not initialized for ${jobName}. Falling back to direct execution if possible.`);
        return false;
    }

    try {
        const defaultOptions = {
            removeOnComplete: {
                age: 24 * 3600, // keep for 24 hours
                count: 1000,   // or max 1000 jobs
            },
            removeOnFail: {
                age: 48 * 3600, // keep failures for 48 hours for debugging
            },
            attempts: options.attempts || (queue.name === 'notification-queue' ? 3 : 5),
            backoff: {
                type: 'exponential',
                delay: options.delay || 2000, 
            },
            ...options
        };

        const job = await queue.add(jobName, data, defaultOptions);
        logger.info('QUEUE:JOB_CREATED', `Enqueued ${jobName} [JobID: ${job.id}] into ${queue.name}`);
        return true;
    } catch (err) {
        logger.error('QUEUE', `Failed to enqueue ${jobName} job`, { error: err.message, stack: err.stack });
        return false;
    }
};

module.exports = {
    QUEUES,
    connection,
    aiQueue,
    webhookQueue,
    subscriptionQueue,
    instagramQueue,
    youtubeQueue,
    replyQueue,
    commentQueue,
    analyticsQueue,
    tokenRefreshQueue,
    notificationQueue,
    authQueue,
    enqueueJob
};
