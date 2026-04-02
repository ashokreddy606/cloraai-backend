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
const mongoose = require('mongoose');
const { getYoutubeOAuth2Client } = require('./config/youtube');
const User = require('../models/User'); // Import Mongoose User model for debugging

// Initialize Mongoose (required for Instagram Analytics)
mongoose.connect(process.env.DATABASE_URL)
    .then(async () => {
        logger.info('WORKER', 'Mongoose connected successfully');
        await debugUserFetching(); // Run diagnostic on startup
    })
    .catch((err) => logger.error('WORKER', 'Mongoose connection error:', { error: err.message }));

/**
 * Diagnostic function to debug why users might not be found by workers.
 * Uses Mongoose for raw inspection of the MongoDB User collection.
 */
async function debugUserFetching() {
    try {
        logger.info('DEBUG_USER', '--- STARTING USER DIAGNOSTIC ---');
        
        // Fetch all users using lean() to see raw data regardless of schema
        const users = await User.find().lean();
        
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


// ─── Core AI Processing Logic ───────────────────────────────────────────────
const processCaptionJob = async (job) => {
    const { topic, tone = 'casual', length = 'short', userId } = job.data;
    const jobId = job.id;

    logger.info('WORKER', `AI job started: ${jobId}`, { topic, userId });
    const startTime = Date.now();

    // 1. Redis-based Result Caching
    // If users request captions for the exact same topic and tone repeatedly, return cached.
    const cacheKey = `caption:${topic.toLowerCase().trim().replace(/\\s+/g, '_')}:${tone}`;
    const cachedResult = await cache.get(cacheKey);

    if (cachedResult) {
        logger.info('WORKER', `AI job completed from cache: ${jobId}`, { processingTimeMs: Date.now() - startTime });
        return { source: 'cache', captions: cachedResult };
    }

    // 2. Rate Limit Protection (Throttling)
    // Add a small 200ms delay to prevent overwhelming OpenAI rate limits during traffic spikes
    await new Promise(resolve => setTimeout(resolve, 200));

    // 3. Optimized Batch Prompt (Generate 5 captions per 1 API call to save time/tokens)
    const prompt = `Generate 5 highly engaging, short Instagram captions about the following topic: "${topic}". \n` +
        `Tone: ${tone}. \n` +
        `Keep each caption under 25 words. Include 1-2 relevant emojis per caption and 3 relevant hashtags at the very end of each caption.\n` +
        `Return the result STRICTLY as a JSON array of 5 plain strings. Example: ["Caption 1 #tag", "Caption 2 #tag"]`;

    // 4. OpenAI Call with optimized parameters
    let captions = [];
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 400
        }, { timeout: 20000 }); // ✨ 3. Add OpenAI Request Timeout (20s)

        const content = response.choices[0].message.content;

        try {
            // Attempt to parse the JSON array requested in the prompt
            captions = JSON.parse(content);
            if (!Array.isArray(captions)) throw new Error("Not an array");
        } catch (e) {
            // Fallback: If OpenAI failed to return valid JSON, split by newlines and clean up
            captions = content.split('\n')
                .filter(line => line.trim().length > 10)
                .map(line => line.replace(/^\d+\.\s*/, '').trim()) // remove numbering like "1. "
                .slice(0, 5); // ensure max 5
        }

        // Cache the successful result for 10 minutes (600 seconds)
        if (captions.length > 0) {
            await cache.set(cacheKey, captions, 600);
        }

        const processingTime = Date.now() - startTime;
        logger.info('WORKER', `AI job completed: ${jobId}`, {
            processingTimeMs: processingTime,
            tokensUsed: response.usage?.total_tokens || 0
        });

        // 10. Return Structured Results
        return { source: 'openai', captions };

    } catch (error) {
        // 8. Robust Error Handling - Rethrow to trigger BullMQ's automatic retry
        // If attemptsMade < 3, BullMQ will retry due to the enqueue options set in queue.js.
        const errorMessage = error.name === 'AbortError' || error.name === 'TimeoutError'
            ? `OpenAI Request Timeout (20s exceeded): ${error.message}`
            : `OpenAI API Error: ${error.message}`;

        logger.error('WORKER', errorMessage, { jobId, error: error.message, stack: error.stack });
        throw new Error(errorMessage);
    }
};

// ─── Initialize BullMQ Workers with Optimized Concurrency ──────────────────
logger.info('WORKER', 'Initializing Redis queue processors...');

// 1. AI Generation Worker
// Concurrency set to 30: Can process 10 simultaneous AI requests in parallel
const aiWorker = new Worker(QUEUES.AI_TASKS, async (job) => {
    return await processCaptionJob(job);
}, {
    connection,
    concurrency: 30
});

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

// 4. Instagram Publishing Worker (DEPRECATED in refactor)
// const { processScheduledPost } = require('./workers/scheduledPostWorker');
// const instagramWorker = new Worker(QUEUES.INSTAGRAM, processScheduledPost, { 
//     connection, 
//     concurrency: 5 
// });


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

attachErrorHandlers(aiWorker, 'AI');
attachErrorHandlers(webhookWorker, 'Webhook');
attachErrorHandlers(subscriptionWorker, 'Subscription');
// attachErrorHandlers(instagramWorker, 'Instagram');

attachErrorHandlers(youtubeWorker, 'YouTube');

// Initializing additional automation
require('./workers/instagramAutomationWorker');
require('./workers/refreshInstagramTokenWorker');

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
    logger.info('WORKER', `${signal} received. Shutting down worker gracefully...`);

    // schedulerTasks and releaseLock removed in refactor


    logger.info('WORKER', 'Draining active queue jobs...');
    // Pausing the workers ensures they stop picking up new jobs
    await Promise.all([
        aiWorker.close(),
        webhookWorker.close(),
        subscriptionWorker.close(),
        instagramWorker.close(),
        youtubeWorker.close()
    ]);

    await prisma.$disconnect();
    logger.info('WORKER', 'Shutdown complete.'); // NO process.exit
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
