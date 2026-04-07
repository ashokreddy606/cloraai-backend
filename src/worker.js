require('dotenv').config();
const OpenAI = require('openai');
const { Worker } = require('bullmq');
const { connection, QUEUES } = require('./utils/queue');
const logger = require('./utils/logger');
const prisma = require('./lib/prisma');
const { cache } = require('./utils/cache');
const { config } = require('./utils/tierConfig');
const { s3Client, awsConfig } = require('./config/aws');
const { initializeFirebase } = require('./lib/firebase');

// ─── Initialize Core Services ────────────────────────────────────────────────
initializeFirebase();


const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ─── Process-Level Error Catchers ────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    logger.error('CRASH_PREVENTION', "UNCAUGHT EXCEPTION IN WORKER", { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('CRASH_PREVENTION', "UNHANDLED REJECTION IN WORKER", { reason });
});

// ─── Start Cron Jobs ─────────────────────────────────────────────────────────
logger.info('WORKER', 'Starting background cron jobs...');

const s3ConfigData = {
    region: awsConfig.region,
    bucket: awsConfig.bucketName,
    hasAccessKey: !!awsConfig.credentials.accessKeyId,
    hasSecretKey: !!awsConfig.credentials.secretAccessKey
};
logger.info('WORKER:S3_DEBUG', 'Verifying AWS S3 Configuration', s3ConfigData);

if (!s3ConfigData.hasAccessKey || !s3ConfigData.hasSecretKey) {
    logger.warn('WORKER:S3_WARNING', 'AWS credentials are missing. Pre-signed URLs will fail.');
}

console.log(`
  🚀 CLORAAI WORKER SYSTEM READY
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🟢 Status: Running [Production]
  📦 Queues: Notification, Webhook, Analytics, Subscriptions
  🛠️  Health: Connection Active
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
logger.info('WORKER', "Worker initialized successfully and listening for jobs");

// ─── Initialize BullMQ Workers ──────────────────────────────────────────────
logger.info('WORKER', 'Initializing Redis queue processors...');

// 1. Notification Worker
const notificationWorker = require('./workers/notificationWorker');

// 2. Webhook Processor
const webhookWorker = new Worker(QUEUES.WEBHOOKS, async (job) => {
    logger.info('WORKER', `Processing webhook: ${job.name}`, { jobId: job.id });
}, {
    connection,
    concurrency: config.concurrency.webhook
});

// 3. Subscription Reconciliation Worker
const subscriptionWorker = new Worker(QUEUES.SUBSCRIPTIONS, async (job) => {
    logger.info('WORKER', `Processing subscription: ${job.name}`, { jobId: job.id });
}, {
    connection,
    concurrency: config.concurrency.subscription
});

// 4. YouTube upload/comment check worker
const { youtubeProcessor } = require('./workers/youtubeWorkerProcessor');
const youtubeWorker = youtubeProcessor; // alias for clarity

// 5. Shared Background Workers
require('./workers/analyticsWorker');
require('./workers/tokenRefreshWorker');
require('./workers/instagramAutomationWorker');
// require('./workers/refreshInstagramTokenWorker'); // Removed: File does not exist
require('./workers/instagramCommentPollWorker');

// Worker Error Event Listeners
const attachErrorHandlers = (worker, name) => {
    worker.on('failed', (job, err) => {
        logger.error('WORKER', `${name} queue job failed`, {
            jobId: job?.id,
            error: err.message,
            attempts: job?.attemptsMade
        });
    });
    worker.on('error', (err) => {
        logger.error('WORKER', `${name} queue worker error`, { error: err.message });
    });
};

attachErrorHandlers(webhookWorker, 'Webhook');
attachErrorHandlers(subscriptionWorker, 'Subscription');
attachErrorHandlers(youtubeWorker, 'YouTube');
attachErrorHandlers(notificationWorker, 'Notification');

// ─── Cron Triggers (Distributed) ───────────────────────────────────────────
const cron = require('node-cron');
const { analyticsQueue, tokenRefreshQueue, enqueueJob } = require('./utils/queue');

// 1. Daily Analytics Trigger (Midnight)
cron.schedule('0 0 * * *', async () => {
    try {
        logger.info('CRON:TRIGGER', 'Starting daily analytics batch enqueue...');
        const accounts = await prisma.instagramAccount.findMany({
            where: { isConnected: true },
            select: { userId: true, instagramId: true, instagramAccessToken: true }
        });
        for (const acc of accounts) {
            await enqueueJob(analyticsQueue, 'process-analytics', {
                userId: acc.userId,
                instagramId: acc.instagramId,
                accessToken: acc.instagramAccessToken
            });
        }
        logger.info('CRON:TRIGGER', `Enqueued ${accounts.length} analytics jobs.`);
    } catch (err) {
        logger.error('CRON:ERROR', 'Daily analytics trigger failed', { error: err.message });
    }
});

// 2. Token Refresh Trigger (1:00 AM)
cron.schedule('0 1 * * *', async () => {
    try {
        logger.info('CRON:TRIGGER', 'Starting token refresh batch check...');
        const fifteenDaysFromNow = new Date();
        fifteenDaysFromNow.setDate(fifteenDaysFromNow.getDate() + 15);

        const accounts = await prisma.instagramAccount.findMany({
            where: { 
                isConnected: true,
                tokenExpiresAt: { lte: fifteenDaysFromNow }
            },
            select: { userId: true, instagramId: true, instagramAccessToken: true }
        });
        for (const acc of accounts) {
            await enqueueJob(tokenRefreshQueue, 'refresh-token', {
                userId: acc.userId,
                instagramId: acc.instagramId,
                accessToken: acc.instagramAccessToken
            });
        }
        logger.info('CRON:TRIGGER', `Enqueued ${accounts.length} token refresh jobs.`);
    } catch (err) {
        logger.error('CRON:ERROR', 'Token refresh trigger failed', { error: err.message });
    }
});

// 3. Instagram Comment Polling (Managed by specialized instagramCommentPollWorker)
// Cron logic has been moved to workers/instagramCommentPollWorker.js for better tier-awareness and locking.

// 4. Notification Cleanup Cron (Every 24 hours at 00:00)
cron.schedule('0 0 * * *', async () => {
    try {
        const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        logger.info('CRON', 'Running 24h notification cleanup...', { threshold });
        
        // Safety check: only run if prisma is connected
        if (prisma.notification) {
            const deleted = await prisma.notification.deleteMany({
                where: {
                    createdAt: {
                        lt: threshold
                    }
                }
            });
            logger.info('CRON', `Cleanup complete: ${deleted.count} notifications removed`);
        }
    } catch (err) {
        logger.error('CRON', 'Notification cleanup failed', { error: err.message });
    }
});
logger.info('WORKER', '✅ Notification cleanup scheduled (daily at 00:00)');

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
    logger.info('WORKER', `${signal} received. Shutting down worker gracefully...`);

    // schedulerTasks and releaseLock removed in refactor


    logger.info('WORKER', 'Draining active queue jobs...');
    // Pausing the workers ensures they stop picking up new jobs
    await Promise.all([
        webhookWorker.close(),
        subscriptionWorker.close(),
        youtubeWorker.close()
    ]);

    await prisma.$disconnect();
    logger.info('WORKER', 'Shutdown complete.'); // NO process.exit
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
