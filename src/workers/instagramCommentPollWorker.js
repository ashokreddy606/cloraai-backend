const cron = require('node-cron');
const { decrypt } = require('../utils/cryptoUtils');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { acquireLock, releaseLock } = require('../utils/redisLock');
const { enqueueJob, commentQueue } = require('../utils/queue');
const instagramService = require('../services/instagramService');
const { cache } = require('../utils/cache');
const { appConfig } = require('../config');
const axios = require('axios');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

// Worker runs every 1 minute
cron.schedule('* * * * *', async () => {
    if (!appConfig.featureFlags.autoDMEnabled) {
        return;
    }

    const lockName = 'ig_comment_poll_worker';
    const locked = await acquireLock(lockName, 55); // Lock for 55s
    if (!locked) return;

    try {
        // Find users with active Instagram Accounts AND active automation rules
        const accounts = await prisma.instagramAccount.findMany({
            where: { isConnected: true },
            include: {
                user: {
                    include: {
                        dmAutomations: { where: { isActive: true } }
                    }
                }
            }
        });

        // Filter accounts that have at least one active rule
        const activeAccounts = accounts.filter(acc => acc.user && acc.user.dmAutomations.length > 0);

        if (activeAccounts.length === 0) return;

        logger.debug('IG_POLL_WORKER', `Starting Instagram Comment Polling for ${activeAccounts.length} accounts`);

        for (const account of activeAccounts) {
            await processAccount(account);
        }
    } catch (error) {
        logger.error('IG_POLL_WORKER', 'Worker failed', error);
    } finally {
        await releaseLock(lockName);
    }
});

async function processAccount(account) {
    try {
        const accessToken = decrypt(account.instagramAccessToken);
        const pageAccessToken = account.pageAccessToken ? decrypt(account.pageAccessToken) : null;
        
        // 1. Fetch latest 3 media
        const mediaList = await instagramService.getUserMedia(account.instagramId, accessToken);
        // Only process the 3 most recent posts to be ultra-safe on Graph API limits
        const topMedia = mediaList.slice(0, 3); 
        
        if (topMedia.length === 0) return;

        for (const media of topMedia) {
            // 2. Fetch comments for media
            try {
                const commentsResponse = await axios.get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${media.id}/comments`, {
                    params: {
                        fields: 'id,text,from,timestamp',
                        access_token: accessToken,
                        limit: 30
                    }
                });

                const comments = commentsResponse.data.data || [];

                for (const comment of comments) {
                    const commentId = comment.id;
                    const senderId = comment.from?.id;
                    const text = comment.text;

                    // Skip self-comments
                    if (senderId === account.instagramId) continue;
                    if (!senderId || !text) continue;

                    // 3. Deduplication via Redis to prevent endless queueing and DB spam
                    const cacheKey = `ig_comment_seen_${commentId}`;
                    const seen = await cache.get(cacheKey);

                    if (seen) continue; // Skip already processed

                    // Mark as seen for 30 days
                    await cache.set(cacheKey, true, 86400 * 30);

                    // 4. Enqueue Job exactly like the webhook
                    logger.info('IG_POLL_WORKER', `New comment detected via poll on media ${media.id}`, { commentId, senderId });
                    
                    await enqueueJob(commentQueue, 'process-comment', {
                        mediaId: media.id,
                        commentId,
                        commentText: text,
                        instagramId: account.instagramId,
                        senderId,
                        userId: account.userId,
                        instagramAccessToken: accessToken,
                        pageAccessToken: pageAccessToken
                    });
                }
            } catch (err) {
                // If comments are disabled on a specific post, Meta throws. We ignore it gracefully.
                if (err.response?.data?.error?.code !== 100) {
                    logger.warn('IG_POLL_WORKER', `Failed to fetch comments for media ${media.id}`, { error: err.response?.data?.error?.message || err.message });
                }
            }
        }
    } catch (error) {
        logger.warn('IG_POLL_WORKER', `Failed processing account ${account.instagramId}`, { error: error.response?.data?.error?.message || error.message });
    }
}

module.exports = {};
