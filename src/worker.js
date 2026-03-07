require('dotenv').config();
const { Worker } = require('bullmq');
const { connection, QUEUES } = require('./utils/queue');
const logger = require('./utils/logger');
const prisma = require('./lib/prisma');

const openai = new OpenAIApi(new Configuration({
    apiKey: process.env.OPENAI_API_KEY
}));

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
        const response = await openai.createChatCompletion({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 400
        });

        const content = response.data.choices[0].message.content;

        try {
            // Attempt to parse the JSON array requested in the prompt
            captions = JSON.parse(content);
            if (!Array.isArray(captions)) throw new Error("Not an array");
        } catch (e) {
            // Fallback: If OpenAI failed to return valid JSON, split by newlines and clean up
            captions = content.split('\\n')
                .filter(line => line.trim().length > 10)
                .map(line => line.replace(/^\\d+\\.\\s*/, '').trim()) // remove numbering like "1. "
                .slice(0, 5); // ensure max 5
        }

        // Cache the successful result for 10 minutes (600 seconds)
        if (captions.length > 0) {
            await cache.set(cacheKey, captions, 600);
        }

        const processingTime = Date.now() - startTime;
        logger.info('WORKER', `AI job completed: ${jobId}`, {
            processingTimeMs: processingTime,
            tokensUsed: response.data.usage?.total_tokens || 0
        });

        // 10. Return Structured Results
        return { source: 'openai', captions };

    } catch (error) {
        logger.error('WORKER', `AI processing failed for job: ${jobId}`, { error: error.message });

        // 8. Robust Error Handling - Rethrow to trigger BullMQ's automatic retry
        // If attemptsMade < 3, BullMQ will retry due to the enqueue options set in queue.js.
        throw new Error(`OpenAI API Error: ${error.message}`);
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
    concurrency: 10 // ✨ 1. Increase Worker Concurrency
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
    logger.info('WORKER', `Processing subscription task: ${job.name}`, { jobId: job.id });
}, {
    connection,
    concurrency: 2
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
        subscriptionWorker.close()
    ]);

    await prisma.$disconnect();
    logger.info('WORKER', 'Shutdown complete.'); // NO process.exit
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log("🚀 CloraAI Worker running [Production Mode]");
console.log("Environment:", process.env.NODE_ENV);
console.log("AI Concurrency: 10 | Webhook Concurrency: 5");
