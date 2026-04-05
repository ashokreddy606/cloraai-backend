const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const { google } = require('googleapis');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { decrypt, encrypt } = require('../utils/cryptoUtils');
const { getYoutubeOAuth2Client } = require('../config/youtube');
const { checkRateLimit } = require('../utils/scaling/rateLimiter');
const { cache } = require('../utils/cache');
const { config } = require('../utils/tierConfig');
const pushNotificationService = require('../services/pushNotificationService');

/**
 * YouTube Worker Processor
 * Processes individual user comment checks in parallel.
 */

const getOAuth2Client = () => getYoutubeOAuth2Client();

// Helper to get an authenticated YouTube client for a user, with token refresh
async function getYoutubeClient(user) {
    const client = getOAuth2Client();
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
            logger.info('YOUTUBE_PROCESSOR', 'Refreshing access token', { userId: user.id });
            await prisma.user.update({
                where: { id: user.id },
                data: { youtubeAccessToken: encrypt(token) }
            });
        }
    } catch (refreshError) {
        logger.error('YOUTUBE_PROCESSOR', 'Token refresh failed', { userId: user.id, error: refreshError.message });
        throw refreshError;
    }

    return google.youtube({ version: 'v3', auth: client });
}

/**
 * Check if a commenter is subscribed to the creator's channel.
 */
async function isCommenterSubscribed(youtube, authorChannelId, channelId) {
    try {
        const subRes = await youtube.subscriptions.list({
            part: 'snippet,subscriberSnippet',
            mySubscribers: true,
            maxResults: 1000,
        });

        const items = subRes.data.items || [];
        const totalResults = subRes.data.pageInfo?.totalResults || 0;
        
        const found = items.some(item => {
            const subId = item.subscriberSnippet?.channelId;
            const snippetSubId = item.snippet?.channelId;
            return (subId && subId === authorChannelId) || (snippetSubId && snippetSubId === authorChannelId);
        });

        if (found) return true;
        if (totalResults > items.length) return true; // Default to allow if more subs than page covers
        return false;
    } catch (apiError) {
        logger.warn('YOUTUBE_PROCESSOR', `Could not fetch sub list: ${apiError.message}. Defaulting to ALLOW.`);
        return true;
    }
}

async function sendReply(youtubeClient, parentId, textOriginal, userId) {
    try {
        if (process.env.DRY_RUN === 'true') {
            logger.info('WORKER:DRY_RUN', `[MOCK] YouTube Reply Sent for thread ${parentId}`);
            return true;
        }
        await youtubeClient.comments.insert({
            part: 'snippet',
            requestBody: {
                snippet: {
                    parentId: parentId,
                    textOriginal: textOriginal
                }
            }
        });
        logger.info('YOUTUBE_PROCESSOR', `Successfully replied to thread ${parentId} for user ${userId}`);
        return true;
    } catch (error) {
        logger.error('YOUTUBE_PROCESSOR', `Failed to send reply to thread ${parentId}`, {
            userId,
            error: error.message,
            details: error.response?.data
        });
        return false;
    }
}

const youtubeProcessor = new Worker(QUEUES.YOUTUBE, async (job) => {
    const { userId } = job.data;
    
    try {
        const rulesCacheKey = `rules:yt:${userId}`;
        let user = await cache.get(rulesCacheKey);

        if (!user) {
            user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true, youtubeConnected: true, youtubeAccessToken: true, youtubeRefreshToken: true,
                    youtubeChannelId: true,
                    youtubeRules: { 
                        where: { isActive: true },
                        select: {
                            id: true, videoId: true, triggerType: true, keyword: true,
                            onlySubscribers: true, limitPerHour: true, isAI: true,
                            replyMessage: true, productName: true, productDescription: true,
                            productUrl: true, appendLinks: true, link1: true, link2: true,
                            link3: true, link4: true
                        }
                    }
                }
            });
            if (user) {
                await cache.set(rulesCacheKey, user, config.cacheTTL.activeRules);
                logger.debug('YOUTUBE_PROCESSOR:RULES', `DB hit: loaded rules for user ${userId}`);
            }
        } else {
            logger.debug('YOUTUBE_PROCESSOR:RULES', `Cache hit: using rules for user ${userId}`);
        }

        if (!user || !user.youtubeConnected || !user.youtubeAccessToken || !user.youtubeChannelId) {
            logger.debug('YOUTUBE_PROCESSOR:SKIP', `User ${userId} not fully connected or missing channelId`);
            return;
        }

        const youtube = await getYoutubeClient(user);
        logger.info('YOUTUBE_PROCESSOR', `Processing user ${user.id}`, { channelId: user.youtubeChannelId });

        let items = [];
        if (process.env.DRY_RUN === 'true') {
            logger.info('WORKER:DRY_RUN', `[MOCK] YouTube Comment List fetched for ${user.id}`);
            // Return one mock item to trigger the logic
            items = [{
                id: 'mock_thread_id',
                snippet: {
                    topLevelComment: {
                        id: 'mock_comment_id',
                        snippet: {
                            videoId: 'mock_video_id',
                            textDisplay: 'mock comment text',
                            authorDisplayName: 'MockUser',
                            authorChannelId: { value: 'mock_author_id' }
                        }
                    }
                }
            }];
        } else {
            const response = await youtube.commentThreads.list({
                part: 'snippet,replies',
                allThreadsRelatedToChannelId: user.youtubeChannelId,
                maxResults: 50,
                order: 'time'
            });

            items = response.data.items || [];
        }
        if (items.length === 0) return;

        for (const item of items) {
            const topLevelComment = item.snippet?.topLevelComment;
            if (!topLevelComment) continue;

            const threadId = item.id;
            const commentId = topLevelComment.id;
            const videoId = topLevelComment.snippet?.videoId || item.snippet?.videoId;
            const textDisplay = (topLevelComment.snippet?.textDisplay || '').toLowerCase();
            const authorDisplayName = topLevelComment.snippet?.authorDisplayName;
            const authorChannelId = topLevelComment.snippet?.authorChannelId?.value;

            if (authorChannelId === user.youtubeChannelId) continue;

            const existingRecord = await prisma.youtubeComment.findUnique({ where: { commentId } });
            if (existingRecord) continue;

            // Logic matching for rules
            let matchedRule = user.youtubeRules.find(
                r => r.videoId === videoId && (r.triggerType === 'any' || textDisplay.includes(r.keyword.toLowerCase()))
            );
            if (!matchedRule) {
                matchedRule = user.youtubeRules.find(
                    r => !r.videoId && (r.triggerType === 'any' || textDisplay.includes(r.keyword.toLowerCase()))
                );
            }
            if (!matchedRule) continue;

            let shouldReply = true;
            let skipReason = null;

            if (matchedRule.onlySubscribers && authorChannelId) {
                shouldReply = await isCommenterSubscribed(youtube, authorChannelId, user.youtubeChannelId);
                if (!shouldReply) skipReason = 'not_subscribed';
            }

            if (shouldReply) {
                // ─── SCALING: MULTI-LAYER RATE LIMIT CHECK ──────────────────────────
                const limit = await checkRateLimit(user.id, 'YOUTUBE', 'comment', matchedRule.limitPerHour);
                
                if (!limit.allowed) {
                    shouldReply = false;
                    skipReason = 'rate_limit';
                    
                    const retryDelay = limit.retryAfter * 1000 || 3600000;
                    logger.warn('YOUTUBE_PROCESSOR:RATE_LIMITED', `User ${user.id} hit YouTube rate limit. Retrying in ${retryDelay}ms`);
                    
                    // Note: Since this is a polling-based worker that processes many rules, 
                    // we don't necessarily want to delay the whole job, 
                    // but we skip this specific reply for now.
                }
            }

            if (shouldReply) {
                let finalMessage = matchedRule.replyMessage;

                if (matchedRule.isAI) {
                    const { checkAILimit } = require('../middleware/aiLimiter');
                    const limitCheck = await checkAILimit(user.id, 'youtube_reply');

                    if (limitCheck.allowed) {
                        const { generateAIReply } = require('../utils/aiUtils');
                        const aiReply = await generateAIReply(topLevelComment.snippet?.textDisplay || '', {
                            userId: user.id,
                            feature: 'youtube_reply',
                            productName: matchedRule.productName,
                            productDescription: matchedRule.productDescription,
                            productUrl: matchedRule.productUrl,
                            isDM: false
                        });
                        if (aiReply) finalMessage = aiReply;
                    } else {
                        logger.warn('YOUTUBE_PROCESSOR:AI_LIMIT_HIT', `AI limit hit for user ${user.id}. Falling back to static reply.`);
                        await pushNotificationService.notifyAILimitHit(user.id, 'youtube_reply').catch(() => {});
                    }
                }

                if (matchedRule.appendLinks) {
                    const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
                    if (links.length > 0) finalMessage += '\n\n' + links.join('\n');
                }

                const replySentSuccessfully = await sendReply(youtube, threadId, finalMessage, user.id);

                if (replySentSuccessfully) {
                    await prisma.youtubeComment.create({
                        data: {
                            userId: user.id,
                            channelId: user.youtubeChannelId,
                            videoId,
                            commentId,
                            username: authorDisplayName || 'Unknown',
                            commentText: topLevelComment.snippet?.textDisplay || '',
                            replied: true
                        }
                    });
                    await pushNotificationService.notifyYouTubeWin(user.id, authorDisplayName || 'Someone').catch(() => {});
                }
            } else if (skipReason !== 'not_subscribed' && skipReason !== 'rate_limit') {
                await prisma.youtubeComment.create({
                    data: {
                        userId: user.id,
                        channelId: user.youtubeChannelId,
                        videoId,
                        commentId,
                        username: authorDisplayName || 'Unknown',
                        commentText: topLevelComment.snippet?.textDisplay || '',
                        replied: false
                    }
                });
            }
        }
        logger.info('YOUTUBE_PROCESSOR:SUCCESS', `Job completed for user ${userId}. Processed ${items.length} threads.`);
    } catch (error) {
        // ── Diagnostic Trap ──
        // Explicitly log the error to console.error to bypass winston for a moment
        // and see the raw error message and stack in the server logs.
        console.error(`❌ YOUTUBE_PROCESSOR CRITICAL FAILURE for user ${userId}:`, error.message);
        if (error.stack) console.error(error.stack);

        logger.error('YOUTUBE_PROCESSOR:FAILED', `Job failed for user ${userId}`, { error: error.message });
        throw error;
    }
}, { 
    connection, 
    concurrency: config.concurrency.youtube  // ✅ Tier-aware concurrency
});

module.exports = { youtubeProcessor };
