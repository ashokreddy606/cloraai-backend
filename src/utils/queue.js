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
    COMMENT: 'instagramAutomationQueue'
};

const aiQueue = new Queue(QUEUES.AI_TASKS, { connection });
const webhookQueue = new Queue(QUEUES.WEBHOOKS, { connection });
const subscriptionQueue = new Queue(QUEUES.SUBSCRIPTIONS, { connection });
const instagramQueue = new Queue(QUEUES.INSTAGRAM, { connection });
const youtubeQueue = new Queue(QUEUES.YOUTUBE, { connection });
const replyQueue = new Queue(QUEUES.REPLY, { connection });
const commentQueue = new Queue(QUEUES.COMMENT, { connection });

// Helper function to add jobs
const enqueueJob = async (queue, jobName, data, options = {}) => {
    try {
        const defaultOptions = {
            removeOnComplete: true,
            removeOnFail: false,
            // default backoff
            backoff: {
                type: 'exponential',
                delay: 1000,
            },
            ...options
        };
        await queue.add(jobName, data, defaultOptions);
        logger.info('QUEUE:JOB_CREATED', `Enqueued ${jobName} job into ${queue.name}`);
    } catch (err) {
        logger.error('QUEUE', `Failed to enqueue ${jobName} job`, { error: err.message });
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
    enqueueJob
};
