require('dotenv').config();
const OpenAI = require('openai');
const { Worker } = require('bullmq');
const { connection, QUEUES } = require('./utils/queue');
const logger = require('./utils/logger');
const prisma = require('./lib/prisma');
const axios = require('axios');
const { decryptToken, decrypt, encrypt } = require('./utils/cryptoUtils');
const { createNotification } = require('./controllers/notificationController');
const { cache } = require('./utils/cache');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { s3Client, awsConfig } = require('./config/aws');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const mongoose = require('mongoose');
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
const subscriptionWorker = new Worker(QUEUES.SUBSCRIPTIONS, async (job) => {
    logger.info('WORKER', `Processing subscription: ${job.name}`, { jobId: job.id });
}, {
    connection,
    concurrency: 2
});

// Helper for YouTube Client in Worker
const getYoutubeClientForWorker = async (user) => {
    const client = new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
        process.env.YOUTUBE_REDIRECT_URI
    );

    const credentials = {
        access_token: decrypt(user.youtubeAccessToken)
    };

    if (user.youtubeRefreshToken) {
        credentials.refresh_token = decrypt(user.youtubeRefreshToken);
    }

    client.setCredentials(credentials);

    try {
        const { token } = await client.getAccessToken();
        if (token && token !== credentials.access_token) {
            await prisma.user.update({
                where: { id: user.id },
                data: { youtubeAccessToken: encrypt(token) }
            });
        }
    } catch (err) {
        logger.error('WORKER:YT', 'Token refresh failed', { userId: user.id, error: err.message });
    }

    return google.youtube({ version: 'v3', auth: client });
};
// 4. Instagram Publishing Worker
const instagramWorker = new Worker(QUEUES.INSTAGRAM, async (job) => {
    const { postId } = job.data;
    logger.info('WORKER:IG', `Processing Instagram job ${job.id}`, { postId });

    try {
        const post = await prisma.scheduledPost.findUnique({
            where: { id: postId },
            include: { 
                user: { 
                    include: { 
                        instagramAccounts: true 
                    } 
                } 
            }
        });

        if (!post) {
            logger.warn('WORKER:IG', `Post ${postId} not found in database.`);
            return;
        }

        if (post.status !== 'publishing' && post.status !== 'IN_PROGRESS') {
            logger.warn('WORKER:IG', `Post ${postId} status is ${post.status}, skipping.`);
            return;
        }

        const igAccount = post.user.instagramAccounts[0];
        if (!igAccount || !igAccount.instagramAccessToken || !igAccount.isConnected) {
            throw new Error('Instagram account not connected.');
        }

        const accessToken = decryptToken(igAccount.instagramAccessToken);
        const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

        // 4a. Robust S3 URL Signed Generation
        let mediaUrlForInstagram = post.mediaUrl;
        if (post.mediaUrl.includes('amazonaws.com') || (post.mediaUrl.includes('s3') && post.mediaUrl.includes('ap-south-2'))) {
            try {
                if (awsConfig.credentials.accessKeyId && awsConfig.credentials.secretAccessKey) {
                    // Using centralized s3Client from ./config/aws
                    const url = new URL(post.mediaUrl);
                    const bucketName = awsConfig.bucketName || url.hostname.split('.')[0];
                    const key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
                    
                    logger.info('WORKER:IG_S3', `Attempting signed URL: ${bucketName}/${key}`);
                    
                    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
                    mediaUrlForInstagram = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                    logger.info('WORKER:IG_S3', 'Generated pre-signed URL successfully');
                }
            } catch (s3Err) {
                logger.error('WORKER:IG_S3_FAIL', `S3 Signing Error: ${s3Err.message}`, { url: post.mediaUrl });
            }
        }

        logger.info('WORKER:IG_META', 'Step A: Creating Media Container');
        let containerRes;
        try {
            containerRes = await axios.post(
                `https://graph.facebook.com/${META_GRAPH_VERSION}/${igAccount.instagramId}/media`,
                {
                    video_url: mediaUrlForInstagram,
                    caption: post.caption,
                    media_type: 'REELS'
                },
                {
                    params: { access_token: accessToken },
                    timeout: 45000
                }
            );
        } catch (apiErr) {
            const errorData = apiErr.response?.data || apiErr.message;
            logger.error('WORKER:IG_STEP_A_FAILED', 'Container creation failed', { error: errorData });
            throw new Error(`Instagram Step A Failed: ${JSON.stringify(errorData)}`);
        }

        const containerId = containerRes.data.id;
        logger.info('WORKER:IG_META', `Step A Success: ${containerId}. Polling for status...`);

        // Step B: Polling for container status
        let isReady = false;
        let attempts = 0;
        const maxAttempts = 20; // 20 attempts * 10s = 200s (3.3 minutes)
        
        while (!isReady && attempts < maxAttempts) {
            attempts++;
            logger.info('WORKER:IG_POLL', `Attempt ${attempts} for ${containerId}: Waiting 10s...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
            
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
                
                const status = statusRes.data.status_code;
                logger.info('WORKER:IG_POLL', `Attempt ${attempts} result: ${status}`, { containerId });
                
                if (status === 'FINISHED') {
                    isReady = true;
                } else if (status === 'ERROR') {
                    const statusDetail = statusRes.data.status || 'Unknown error';
                    logger.error('WORKER:IG_POLL_ERROR', `Container failed: ${statusDetail}`, { containerId });
                    throw new Error(`Instagram processing failed (ERROR): ${statusDetail}`);
                }
            } catch (pollErr) {
                const errDetail = pollErr.response?.data || pollErr.message;
                logger.warn('WORKER:IG_POLL_WARN', `Polling error: ${JSON.stringify(errDetail)}`);
            }
        }

        if (!isReady) {
            throw new Error('Instagram container timed out after 150s of processing.');
        }

        // Step C: Publish the container
        logger.info('WORKER:IG_META', `Step C: Publishing container ${containerId}`);
        let publishRes;
        try {
            publishRes = await axios.post(
                `https://graph.facebook.com/${META_GRAPH_VERSION}/${igAccount.instagramId}/media_publish`,
                { creation_id: containerId },
                {
                    params: { access_token: accessToken },
                    timeout: 45000
                }
            );
        } catch (apiErr) {
            const errorData = apiErr.response?.data || apiErr.message;
            logger.error('WORKER:IG_STEP_C_FAILED', 'Publication failed', { error: errorData });
            throw new Error(`Instagram Step C Failed: ${JSON.stringify(errorData)}`);
        }

        const instagramPostId = publishRes.data.id;
        logger.info('WORKER:IG_SUCCESS', `Published! IG Post ID: ${instagramPostId}`);

        await prisma.scheduledPost.update({
            where: { id: post.id },
            data: {
                status: 'PUBLISHED',
                publishedAt: new Date(),
                instagramPostId: instagramPostId,
                errorMessage: null
            }
        });

        await createNotification(post.userId, {
            type: 'success', icon: 'checkmark-circle', color: '#10B981',
            title: 'Instagram Post Published!', body: 'Your scheduled reel was successfully published.'
        }).catch(e => logger.warn('WORKER:NOTIFY', e.message));

    } catch (error) {
        logger.error('WORKER:IG', 'Instagram worker job failed', { postId, error: error.message });
        if (postId) {
            await prisma.scheduledPost.update({
                where: { id: postId },
                data: {
                    status: 'failed',
                    errorMessage: error.message
                }
            }).catch(e => logger.error('WORKER:IG', 'Failed to update post status', { error: e.message }));
        }
        throw error;
    }
}, { connection, concurrency: 5 });

// 5. YouTube Upload Worker
const youtubeWorker = new Worker(QUEUES.YOUTUBE, async (job) => {
    const { postId } = job.data;
    let post;
    try {
        post = await prisma.scheduledPost.findUnique({
            where: { id: postId },
            include: { user: true }
        });

        if (!post || post.status !== 'publishing') return;

        if (!post.user.youtubeAccessToken || !post.user.youtubeRefreshToken) {
            throw new Error('YouTube account not connected.');
        }

        let tempFilePath = null;
        try {
            const youtube = await getYoutubeClientForWorker(post.user);
            
            // 1. Download video from S3 URL to temp file
            const tempDir = path.join(os.tmpdir(), 'cloraai-worker-uploads');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            
            const fileName = `post_${post.id}_${Date.now()}.mp4`;
            tempFilePath = path.join(tempDir, fileName);
            
            logger.info('WORKER:YT', `Downloading video from ${post.mediaUrl} to ${tempFilePath}`);
            const response = await axios({
                method: 'get',
                url: post.mediaUrl,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // 2. Upload to YouTube
            logger.info('WORKER:YT', `Uploading to YouTube for user ${post.userId}`);
            const uploadRes = await youtube.videos.insert({
                part: 'snippet,status',
                requestBody: {
                    snippet: {
                        title: post.title || post.caption.substring(0, 100),
                        description: post.caption,
                        categoryId: '22',
                    },
                    status: {
                        privacyStatus: 'public', // Default to public for scheduled posts
                    },
                },
                media: {
                    body: fs.createReadStream(tempFilePath),
                },
            });

            // 3. Update DB
            await prisma.scheduledPost.update({
                where: { id: post.id },
                data: {
                    status: 'published',
                    publishedAt: new Date(),
                    youtubeVideoId: uploadRes.data.id,
                    errorMessage: null
                }
            });

            await createNotification(post.userId, {
                type: 'success', icon: 'logo-youtube', color: '#FF0000',
                title: 'YouTube Short Uploaded!', body: 'Your scheduled short was successfully uploaded.'
            }).catch(e => logger.warn('WORKER:NOTIFY', e.message));

        } catch (error) {
            logger.error('WORKER:YT', 'YouTube worker upload failed', { postId, error: error.message });
            throw error; // Let the outer catch handle DB update
        } finally {
            // Clean up temp file
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                fs.unlink(tempFilePath, (err) => {
                    if (err) logger.warn('WORKER:YT', 'Failed to delete temp file', { tempFilePath, error: err.message });
                });
            }
        }
    } catch (error) {
        logger.error('WORKER:YT', 'YouTube worker job failed', { postId, error: error.message });
        if (postId) {
            await prisma.scheduledPost.update({
                where: { id: postId },
                data: {
                    status: 'failed',
                    errorMessage: error.message
                }
            }).catch(e => logger.error('WORKER:YT', 'Failed to update post status in catch block', { error: e.message }));
        }
        throw error;
    }
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

// Initializing additional automation
require('./workers/instagramAutomationWorker');
require('./workers/refreshInstagramTokenWorker');

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
