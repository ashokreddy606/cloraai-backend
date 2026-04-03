require('dotenv').config();
const OpenAI = require('openai');
const { Worker } = require('bullmq');
const { connection, QUEUES } = require('./utils/queue');
const logger = require('./utils/logger');
const prisma = require('./lib/prisma');
const axios = require('axios');
const { decryptToken, decrypt, encrypt } = require('./utils/cryptoUtils');
// const { createNotification } = require('./controllers/notificationController'); // Deleted in refactor
const { cache } = require('./utils/cache');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { s3Client, awsConfig } = require('./config/aws');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getYoutubeOAuth2Client } = require('./config/youtube');
// const User = require('../models/User'); // Deleted in Prisma migration

// Run diagnostics on startup
debugUserFetching();

/**
 * Diagnostic function to debug why users might not be found by workers.
 * Uses Mongoose for raw inspection of the MongoDB User collection.
 */
async function debugUserFetching() {
    try {
        logger.info('DEBUG_USER', '--- STARTING USER DIAGNOSTIC ---');
        
        // Fetch all users using Prisma to see raw data
        const users = await prisma.user.findMany({
            include: { instagramAccounts: true }
        });
        
        console.log("🔥 TOTAL USERS IN DB:", users.length);

        const safeUsers = users.map(u => {
            const user = { ...u };
            // Mask sensitive fields
            if (user.password) user.password = '***';
            if (user.youtubeAccessToken) user.youtubeAccessToken = '***';
            if (user.youtubeRefreshToken) user.youtubeRefreshToken = '***';
            if (user.instagramAccessToken) user.instagramAccessToken = '***';
            if (user.pageAccessToken) user.pageAccessToken = '***';
            
            // Helpful derived flags for logging
            user._hasYoutube = !!user.youtubeChannelId && !!user.youtubeAccessToken;
            user._hasInstagram = !!user.instagramAccounts && user.instagramAccounts.length > 0;
            user._isActive = user.isActive !== false; // handle missing field as active if that's the logic

            return user;
        });

        console.log("🔥 ALL USERS (Masked):", JSON.stringify(safeUsers, null, 2));

        const activeUsersCount = safeUsers.filter(u => u.isActive || u.isActive === undefined).length;
        const ytConnectedCount = safeUsers.filter(u => u._hasYoutube).length;
        
        console.log("✅ ACTIVE USERS COUNT:", activeUsersCount);
        console.log("📺 YOUTUBE CONNECTED COUNT:", ytConnectedCount);
        
        if (users.length > 0) {
            console.log("ℹ️ SAMPLE USER FIELDS:", Object.keys(users[0]));
        }

        logger.info('DEBUG_USER', '--- USER DIAGNOSTIC COMPLETE ---');
    } catch (error) {
        logger.error('DEBUG_USER', '❌ ERROR FETCHING USERS:', { error: error.message });
        console.error("❌ ERROR FETCHING USERS:", error);
    }
}

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

// ─── S3 Environment Sync Check ───────────────────────────────────────────────
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

// ─── Initializing Redis queue processors...
console.log("🚀 CloraAI Worker running [Production Mode]");

// const { schedulerTasks, releaseLock } = require('./services/schedulerCron'); // Deleted in refactor
logger.info('WORKER', "Worker initialized successfully");



// ─── Initialize BullMQ Workers with Optimized Concurrency ──────────────────
logger.info('WORKER', 'Initializing Redis queue processors...');


// 2. Webhook Processor
// Concurrency set to 5 for Instagram/Payment webhooks
const webhookWorker = new Worker(QUEUES.WEBHOOKS, async (job) => {
    logger.info('WORKER', `Processing webhook: ${job.name}`, { jobId: job.id });
}, {
    connection,
    concurrency: 5
});

// 3. Subscription Reconciliation Worker
// Concurrency set to 2 to gently handle internal db updates
const subscriptionWorker = new Worker(QUEUES.SUBSCRIPTIONS, async (job) => {
    logger.info('WORKER', `Processing subscription: ${job.name}`, { jobId: job.id });
}, {
    connection,
    concurrency: 2
});



// 5. YouTube Upload Worker (Consolidated)
const { processYoutubeUpload } = require('./workers/youtubeUploadWorker');
const youtubeWorker = new Worker(QUEUES.YOUTUBE, processYoutubeUpload, { 
    connection, 
    concurrency: 3 
});

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

// Initializing additional automation
require('./workers/instagramAutomationWorker');
require('./workers/refreshInstagramTokenWorker');

// ─── Comment Poller Cron (Fallback for missed Meta webhooks) ─────────────────
const cron = require('node-cron');
const { pollInstagramComments } = require('./services/instagramCommentPoller');

// Run every 2 minutes to catch any comments Meta webhooks may have missed
cron.schedule('*/2 * * * *', async () => {
    try {
        logger.info('CRON', 'Running Instagram comment poller...');
        await pollInstagramComments();
    } catch (err) {
        logger.error('CRON', 'Comment poller cron failed', { error: err.message });
    }
});
logger.info('WORKER', '✅ Comment poller cron scheduled (every 2 minutes)');

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
