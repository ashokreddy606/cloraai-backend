const cron = require('node-cron');
const { decrypt } = require('../utils/cryptoUtils');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { acquireLock, releaseLock } = require('../utils/redisLock');
const { enqueueJob, commentQueue } = require('../utils/queue');
const instagramService = require('../services/instagramService');
const { cache } = require('../utils/cache');
const { appConfig } = require('../config');
const { config, TIER } = require('../utils/tierConfig');
const { checkBackpressure } = require('../utils/scaling/backpressure');
const { getDynamicDelay } = require('../utils/scaling/delayEngine');
const axios = require('axios');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

// ✅ PERF: Use tier-aware cron schedule
// FREE: Every 3min  |  SMALL: Every 2min  |  LARGE: Every 1min
cron.schedule(config.cron.instagramPoll, async () => {
    if (!appConfig.featureFlags.autoDMEnabled) return;

    const lockName = 'ig_comment_poll_worker';
    const locked = await acquireLock(lockName, 110);
    if (!locked) return;

    try {
        // ✅ PERF FIX: Cache the active accounts list.
        // This was hitting the DB every 1 minute for ALL active accounts — at 25K users
        // that's a massive read every minute. Cache it for the tier-appropriate TTL.
        const CACHE_KEY = 'ig_poll_active_accounts';
        let activeAccounts = await cache.get(CACHE_KEY);

        if (!activeAccounts) {
            const accounts = await prisma.instagramAccount.findMany({
                where: { isConnected: true },
                select: {
                    id: true,
                    instagramId: true,
                    userId: true,
                    instagramAccessToken: true,
                    pageAccessToken: true,
                    user: {
                        select: {
                            dmAutomations: {
                                where: { isActive: true },
                                select: { id: true, keyword: true, autoReplyMessage: true }
                            }
                        }
                    }
                }
            });

            // ✅ PERF: Only select relevant fields, skip accounts with no rules
            activeAccounts = accounts.filter(acc => acc.user?.dmAutomations?.length > 0);
            await cache.set(CACHE_KEY, activeAccounts, config.cacheTTL.activeAccounts);
            logger.debug('IG_POLL_WORKER', `Cache miss: loaded ${activeAccounts.length} active accounts from DB`);
        } else {
            logger.debug('IG_POLL_WORKER', `Cache hit: using ${activeAccounts.length} active accounts`);
        }

        if (activeAccounts.length === 0) return;

        // ✅ BACKPRESSURE: Skip polling if queue is already overloaded
        const pressure = await checkBackpressure(commentQueue, config.backpressure.commentQueue);
        if (pressure.overloaded) {
            logger.warn('IG_POLL_WORKER:BACKPRESSURE', `Queue overloaded (${pressure.count} jobs). Skipping poll cycle.`);
            return;
        }

        logger.debug('IG_POLL_WORKER', `Polling ${activeAccounts.length} accounts (Tier: ${TIER})`);

        // Process all accounts in parallel (controlled batch for free tier)
        const batchSize = config.batch.analyticsConcurrentUsers;
        for (let i = 0; i < activeAccounts.length; i += batchSize) {
            const batch = activeAccounts.slice(i, i + batchSize);
            await Promise.allSettled(batch.map(account => processAccount(account)));
        }

    } catch (error) {
        logger.error('IG_POLL_WORKER', 'Worker failed', { error: error.message });
    } finally {
        await releaseLock(lockName);
    }
});

async function processAccount(account) {
    try {
        const accessToken = decrypt(account.instagramAccessToken);
        const pageAccessToken = account.pageAccessToken ? decrypt(account.pageAccessToken) : null;

        if (!accessToken) {
            logger.warn('IG_POLL_WORKER', `Skipping account ${account.instagramId}: Token decryption failed.`);
            return;
        }

        const mediaList = await instagramService.getUserMedia(account.instagramId, accessToken);
        // ✅ PERF: Only check N most recent posts (tier-aware: 2 for free, 3 for paid)
        const topMedia = mediaList.slice(0, config.batch.pollTopMedia);

        if (topMedia.length === 0) return;

        for (const media of topMedia) {
            try {
                const commentsResponse = await axios.get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${media.id}/comments`, {
                    params: {
                        fields: 'id,text,from,timestamp',
                        access_token: accessToken,
                        limit: config.batch.pollCommentLimit  // ✅ Tier-aware limit
                    }
                });

                const comments = commentsResponse.data.data || [];

                for (const comment of comments) {
                    const commentId = comment.id;
                    const senderId = comment.from?.id;
                    const text = comment.text;

                    if (senderId === account.instagramId) continue;
                    if (!senderId || !text) continue;

                    // Deduplication via Redis
                    const cacheKey = `ig_comment_seen_${commentId}`;
                    const seen = await cache.get(cacheKey);
                    if (seen) continue;

                    // Mark as seen for 30 days
                    await cache.set(cacheKey, true, 86400 * 30);

                    // ✅ Dynamic delay: simulates human timing, prevents bot detection
                    const delay = await getDynamicDelay(commentQueue);

                    logger.info('IG_POLL_WORKER', `New comment via poll on media ${media.id}`, { commentId, senderId });

                    await enqueueJob(commentQueue, 'process-comment', {
                        mediaId: media.id,
                        commentId,
                        commentText: text,
                        instagramId: account.instagramId,
                        senderId,
                        userId: account.userId,
                        instagramAccessToken: accessToken,
                        pageAccessToken: pageAccessToken
                    }, { delay });
                }
            } catch (err) {
                if (err.response?.data?.error?.code !== 100) {
                    logger.warn('IG_POLL_WORKER', `Failed to fetch comments for media ${media.id}`, {
                        error: err.response?.data?.error?.message || err.message
                    });
                }
            }
        }
    } catch (error) {
        logger.warn('IG_POLL_WORKER', `Failed processing account ${account.instagramId}`, {
            error: error.response?.data?.error?.message || error.message
        });
    }
}

module.exports = {};
