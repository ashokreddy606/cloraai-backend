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

/**
 * instagramCommentPollWorker.js
 * 
 * Polling runner for Instagram account comments.
 * Used as a fallback for webhooks and for FREE tier users.
 */

cron.schedule(config.cron.instagramPoll, async () => {
    if (!appConfig.featureFlags.autoDMEnabled) return;

    const lockName = 'ig_comment_poll_worker';
    const locked = await acquireLock(lockName, 110);
    if (!locked) return;

    try {
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
                    username: true,
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

            activeAccounts = accounts.filter(acc => acc.user?.dmAutomations?.length > 0);
            await cache.set(CACHE_KEY, activeAccounts, config.cacheTTL.activeAccounts);
            logger.debug('IG_POLL_WORKER', `Cache miss: loaded ${activeAccounts.length} active accounts from DB`);
        } else {
            logger.debug('IG_POLL_WORKER', `Cache hit: using ${activeAccounts.length} active accounts`);
        }

        if (activeAccounts.length === 0) return;

        const pressure = await checkBackpressure(commentQueue, config.backpressure.commentQueue);
        if (pressure.overloaded) {
            logger.warn('IG_POLL_WORKER:BACKPRESSURE', `Queue overloaded (${pressure.count} jobs). Skipping poll cycle.`);
            return;
        }

        logger.debug('IG_POLL_WORKER', `Polling ${activeAccounts.length} accounts (Tier: ${TIER})`);

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

        logger.info('IG_POLL_WORKER', `Processing account ${account.instagramId} (@${account.username || 'unknown'})`);

        const mediaList = await instagramService.getUserMedia(account.instagramId, accessToken);
        const topMedia = mediaList.slice(0, config.batch.pollTopMedia);

        if (topMedia.length === 0) {
            logger.info('IG_POLL_WORKER', `No recent media found for account ${account.instagramId}`);
            return;
        }

        logger.info('IG_POLL_WORKER', `Checking ${topMedia.length} top media items for account ${account.instagramId}`);

        for (const media of topMedia) {
            try {
                logger.debug('IG_POLL_WORKER', `Fetching comments for media ${media.id}`);
                
                const commentsResponse = await axios.get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${media.id}/comments`, {
                    params: {
                        fields: 'id,text,from,timestamp',
                        access_token: accessToken,
                        limit: config.batch.pollCommentLimit,
                        order: 'reverse_chronological'
                    }
                });

                const comments = commentsResponse.data.data || [];
                logger.info('IG_POLL_WORKER', `Found ${comments.length} comments on media ${media.id}`);

                for (const comment of comments) {
                    const commentId = comment.id;
                    const senderId = comment.from?.id;
                    const text = comment.text;

                    if (senderId === account.instagramId) {
                        logger.debug('IG_POLL_WORKER', `Skipping self-comment ${commentId}`);
                        continue;
                    }
                    if (!senderId || !text) {
                        logger.warn('IG_POLL_WORKER', `Skipping comment ${commentId}: Missing sender or text`);
                        continue;
                    }

                    const cacheKey = `ig_comment_seen_${commentId}`;
                    const seen = await cache.get(cacheKey);
                    if (seen) {
                        logger.debug('IG_POLL_WORKER', `Comment ${commentId} already processed (cache hit)`);
                        continue;
                    }

                    await cache.set(cacheKey, true, 86400 * 30);
                    const delay = await getDynamicDelay(commentQueue);

                    logger.info('IG_POLL_WORKER:NEW_DETECTED', `New comment ${commentId} by ${senderId} on media ${media.id}. Text: "${text.substring(0, 30)}..."`, { delay });

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

                    logger.info('IG_POLL_WORKER:QUEUED', `Queued process-comment for ${commentId}`);
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
