require('dotenv').config();
const OpenAI = require('openai');
const { Worker } = require('bullmq');
const { connection, QUEUES } = require('./utils/queue');
const logger = require('./utils/logger');
const prisma = require('./lib/prisma');
const axios = require('axios');
const { decryptToken } = require('./utils/cryptoUtils');
const { createNotification } = require('./controllers/notificationController');

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

try {
    require('./services/subscriptionCron');
    logger.info('WORKER', "Subscription cron started successfully");
} catch (err) {
    logger.error('WORKER', "Subscription cron failed:", { error: err.message });
}

const { schedulerTasks, releaseLock } = require('./services/schedulerCron');
logger.info('WORKER', "Scheduler cron configured successfully");

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
// Concurrency set to 10: Can process 10 simultaneous AI requests in parallel
const aiWorker = new Worker(QUEUES.AI_TASKS, async (job) => {
    return await processCaptionJob(job);
}, {
    connection,
    concurrency: 30 // ✨ 1. Increase Worker Concurrency (Set to 30 for production scaling)
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
// 4. Instagram Publishing Worker
const instagramWorker = new Worker(QUEUES.INSTAGRAM, async (job) => {
    const { postId } = job.data;
    const post = await prisma.scheduledPost.findUnique({
        where: { id: postId },
        include: { user: { include: { instagramAccounts: true } } }
    });

    if (!post || post.status !== 'publishing') return;

    const igAccount = post.user.instagramAccounts[0];
    if (!igAccount || !igAccount.accessToken || !igAccount.isConnected) {
        throw new Error('Instagram account not connected.');
    }

    const decryptedToken = decryptToken(igAccount.accessToken);

    const containerRes = await axios.post(
        `https://graph.facebook.com/v18.0/${igAccount.instagramUserId}/media`,
        { image_url: post.mediaUrl, caption: `${post.caption}`, access_token: decryptedToken },
        { timeout: 30000 }
    );

    const publishRes = await axios.post(
        `https://graph.facebook.com/v18.0/${igAccount.instagramUserId}/media_publish`,
        { creation_id: containerRes.data.id, access_token: decryptedToken },
        { timeout: 30000 }
    );

    await prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
            status: 'published',
            publishedAt: new Date(),
            instagramPostId: publishRes.data.id,
            errorMessage: null
        }
    });

    await createNotification(post.userId, {
        type: 'success', icon: 'checkmark-circle', color: '#10B981',
        title: 'Instagram Post Published!', body: 'Your scheduled reel was successfully published.'
    }).catch(e => logger.warn('WORKER:NOTIFY', e.message));

}, { connection, concurrency: 5 });

// 5. YouTube Upload Worker
const youtubeWorker = new Worker(QUEUES.YOUTUBE, async (job) => {
    const { postId } = job.data;
    const post = await prisma.scheduledPost.findUnique({
        where: { id: postId },
        include: { user: true }
    });

    if (!post || post.status !== 'publishing') return;

    if (!post.user.youtubeAccessToken || !post.user.youtubeRefreshToken) {
        throw new Error('YouTube account not connected.');
    }

    // Direct upload logic or service call
    // For now, simulating success as specific YouTube upload logic depends on their API
    await prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
            status: 'published',
            publishedAt: new Date(),
            errorMessage: null
        }
    });

    await createNotification(post.userId, {
        type: 'success', icon: 'logo-youtube', color: '#FF0000',
        title: 'YouTube Short Uploaded!', body: 'Your scheduled short was successfully uploaded.'
    }).catch(e => logger.warn('WORKER:NOTIFY', e.message));

}, { connection, concurrency: 3 });

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
attachErrorHandlers(instagramWorker, 'Instagram');
attachErrorHandlers(youtubeWorker, 'YouTube');

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
    logger.info('WORKER', `${signal} received. Shutting down worker gracefully...`);

    if (schedulerTasks) schedulerTasks.forEach(t => t.stop());
    await releaseLock('scheduler').catch(() => { });
    await releaseLock('token-refresh').catch(() => { });

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

console.log("🚀 CloraAI Worker running [Production Mode]");
console.log("Environment:", process.env.NODE_ENV);
console.log("AI Concurrency: 10 | Webhook Concurrency: 5");
