const cron = require('node-cron');
const { decrypt, encrypt } = require('../utils/cryptoUtils');
const { google } = require('googleapis');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { acquireLock, releaseLock } = require('../utils/redisLock');

const getOAuth2Client = () => {
    return new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET,
        process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5000/api/youtube/callback'
    );
};

// Worker runs every 1 minute
cron.schedule('* * * * *', async () => {
    const { appConfig } = require('../config');
    if (!appConfig.featureFlags.youtubeAutomationEnabled) {
        logger.debug('YOUTUBE_WORKER', 'YouTube Automation is globally disabled. Skipping.');
        return;
    }

    const lockName = 'youtube_cron';
    const locked = await acquireLock(lockName, 110);

    if (!locked) {
        logger.debug('YOUTUBE_WORKER', 'Cron is locked by another instance. Skipping.');
        return;
    }

    logger.info('YOUTUBE_WORKER', 'Starting YouTube background worker to fetch comments');

    try {
        const usersWithYoutube = await prisma.user.findMany({
            where: {
                youtubeChannelId: { not: null },
                youtubeAccessToken: { not: null },
                youtubeRules: { some: { isActive: true } }
            },
            include: {
                youtubeRules: { where: { isActive: true } }
            }
        });

        if (usersWithYoutube.length === 0) {
            return logger.info('YOUTUBE_WORKER', 'No active users found for processing');
        }

        for (const user of usersWithYoutube) {
            await processUser(user);
        }

    } catch (error) {
        logger.error('YOUTUBE_WORKER', 'Worker failed', error);
    } finally {
        await releaseLock(lockName);
    }
});

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
            logger.info('YOUTUBE_WORKER', 'Refreshing access token', { userId: user.id });
            await prisma.user.update({
                where: { id: user.id },
                data: { youtubeAccessToken: encrypt(token) }
            });
        }
    } catch (refreshError) {
        logger.error('YOUTUBE_WORKER', 'Token refresh failed', { userId: user.id, error: refreshError.message });
        throw refreshError;
    }

    return google.youtube({ version: 'v3', auth: client });
}

/**
 * Check if a commenter is subscribed to the creator's channel.
 *
 * NOTE: YouTube API limitation — you CANNOT check whether a specific user
 * is subscribed to your channel using the owner's token. The only available
 * API is `subscriptions.list` with `mySubscribers: true` which returns a
 * paginated list of ALL subscribers (up to 1000 per page).
 *
 * Strategy:
 *  1. Fetch the first page of subscribers (1000 per page).
 *  2. Check if the commenter's channelId is in that list.
 *  3. If the channel has more subscribers than one page covers, we cannot
 *     guarantee accuracy — in that case we default to ALLOW (send reply)
 *     to avoid false negatives that would block legitimate subscribers.
 */
async function isCommenterSubscribed(youtube, authorChannelId, channelId) {
    try {
        const subRes = await youtube.subscriptions.list({
            part: 'snippet,subscriberSnippet',
            mySubscribers: true,
            maxResults: 1000,
        });

        const items = subRes.data.items || [];
        
        // Find the subscriber in the list
        // item.snippet.resourceId.channelId is usually the host channel if mySubscribers=true
        // item.subscriberSnippet.channelId is the subscriber's channel ID
        const found = items.some(item => {
            const subId = item.subscriberSnippet?.channelId;
            return subId === authorChannelId;
        });

        if (found) {
            logger.info('YOUTUBE_WORKER', `Subscriber confirmed: ${authorChannelId}`);
            return true;
        }

        // If there are more subscribers than this page shows, we can't be sure
        // they aren't subscribed — default to ALLOW to avoid blocking real subscribers
        const totalResults = subRes.data.pageInfo?.totalResults || 0;
        if (totalResults > items.length) {
            logger.info('YOUTUBE_WORKER', `Channel has ${totalResults} subscribers (only ${items.length} fetched). Cannot confirm ${authorChannelId} — defaulting to ALLOW to avoid false negatives.`);
            return true;
        }

        logger.info('YOUTUBE_WORKER', `Not subscribed: ${authorChannelId} is not in public subscriber list of ${channelId}`);
        return false;

    } catch (apiError) {
        // Common causes: missing scope, quota exceeded, or privacy settings — default to ALLOW
        logger.warn('YOUTUBE_WORKER', `Could not fetch subscriber list for channel ${channelId}: ${apiError.message}. Defaulting to ALLOW.`);
        return true;
    }
}

async function processUser(user) {
    let youtube;
    try {
        youtube = await getYoutubeClient(user);
        logger.info('YOUTUBE_WORKER', `Processing user ${user.id}`, { channelId: user.youtubeChannelId });

        const response = await youtube.commentThreads.list({
            part: 'snippet,replies',
            allThreadsRelatedToChannelId: user.youtubeChannelId,
            maxResults: 50, // Increased from 20
            order: 'time'
        });

        const items = response.data.items || [];
        if (items.length === 0) {
            logger.info('YOUTUBE_WORKER', `No new comments for user ${user.id}`);
            return;
        }

        for (const item of items) {
            const topLevelComment = item.snippet?.topLevelComment;
            if (!topLevelComment) continue;

            const threadId = item.id;
            const commentId = topLevelComment.id;
            const videoId = topLevelComment.snippet?.videoId || item.snippet?.videoId;
            const textDisplay = (topLevelComment.snippet?.textDisplay || '').toLowerCase();
            const authorDisplayName = topLevelComment.snippet?.authorDisplayName;
            const authorChannelId = topLevelComment.snippet?.authorChannelId?.value;

            // Prevent replying to own comments
            if (authorChannelId === user.youtubeChannelId) continue;

            // Deduplicate: skip already-processed comments
            const existingRecord = await prisma.youtubeComment.findUnique({
                where: { commentId }
            });
            if (existingRecord) {
                // Keep this as debug to avoid flooding logs with old comments
                logger.debug('YOUTUBE_WORKER', `Comment already processed: ${commentId}. Skipping.`);
                continue;
            }

            // Keyword matching — video-specific rule takes priority over global
            let matchedRule = user.youtubeRules.find(
                r => r.videoId === videoId && textDisplay.includes(r.keyword.toLowerCase())
            );
            if (!matchedRule) {
                matchedRule = user.youtubeRules.find(
                    r => !r.videoId && textDisplay.includes(r.keyword.toLowerCase())
                );
            }
            if (!matchedRule) {
                // If no rule matches, we can optionally save it as "processed" so we don't log it every time
                // but for now we'll just skip to keep DB clean. If we want it to stop bothering us:
                // await prisma.youtubeComment.create({ data: { ... replied: false } });
                continue; 
            }

            logger.info('YOUTUBE_WORKER', `Keyword match: "${matchedRule.keyword}" in comment ${commentId}`);

            // ── Subscriber check ──────────────────────────────────────────────
            let shouldReply = true;
            let skipReason = null;

            if (matchedRule.onlySubscribers) {
                if (!authorChannelId) {
                    logger.warn('YOUTUBE_WORKER', `Missing authorChannelId for comment ${commentId}. Skipping.`);
                    shouldReply = false;
                    skipReason = 'missing_author_id';
                } else {
                    shouldReply = await isCommenterSubscribed(youtube, authorChannelId, user.youtubeChannelId);
                    if (!shouldReply) {
                        logger.info('YOUTUBE_WORKER', `Skipping reply: ${authorChannelId} is not a subscriber.`);
                        skipReason = 'not_subscribed';
                    }
                }
            }

            // ── Rate limit check ──────────────────────────────────────────────
            if (shouldReply) {
                const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
                const recentRepliesCount = await prisma.youtubeComment.count({
                    where: {
                        userId: user.id,
                        replied: true,
                        createdAt: { gte: oneHourAgo }
                    }
                });
                if (recentRepliesCount >= matchedRule.limitPerHour) {
                    logger.warn('YOUTUBE_WORKER', `Rate limit exceeded for user ${user.id} (Rule: ${matchedRule.keyword})`);
                    shouldReply = false;
                    skipReason = 'rate_limit';
                }
            }

            // ── Global feature flag ───────────────────────────────────────────
            if (shouldReply) {
                const { appConfig } = require('../config');
                if (!appConfig.featureFlags.youtubeCommentRepliesEnabled) {
                    logger.debug('YOUTUBE_WORKER', 'Comment replies are globally disabled.');
                    shouldReply = false;
                    skipReason = 'feature_disabled';
                }
            }

            // ── Final Decision ────────────────────────────────────────────────
            if (shouldReply) {
                let finalMessage = matchedRule.replyMessage;
                if (matchedRule.appendLinks) {
                    const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
                    if (links.length > 0) {
                        finalMessage += '\n\n' + links.join('\n');
                    }
                }

                let replySentSuccessfully = false;
                if (matchedRule.replyDelay > 0) {
                    logger.info('YOUTUBE_WORKER', `Delaying reply for ${matchedRule.replyDelay}s: ${commentId}`);
                    setTimeout(async () => {
                        await sendReply(youtube, threadId, finalMessage, user.id);
                    }, matchedRule.replyDelay * 1000);
                    replySentSuccessfully = true; // We mark as sent to avoid duplicate triggers during the delay
                } else {
                    replySentSuccessfully = await sendReply(youtube, threadId, finalMessage, user.id);
                }

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
                    }).catch(err => logger.error('YOUTUBE_WORKER', `Failed to save reply record`, err));
                }
            } else {
                // CRITICAL CHANGE: If skipped due to subscriber status or rate limit, 
                // DO NOT save to DB yet. This allows retrying in the next cron run 
                // if they subscribe or the hour passes.
                
                if (skipReason === 'not_subscribed' || skipReason === 'rate_limit') {
                    logger.info('YOUTUBE_WORKER', `Comment ${commentId} skipped due to ${skipReason}. NOT saving to DB to allow retry.`);
                } else {
                    // Save as permanent skip
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
                    }).catch(err => logger.error('YOUTUBE_WORKER', `Failed to save skip record`, err));
                }
            }
        }
    } catch (error) {
        logger.error('YOUTUBE_WORKER', `Failed to process user ${user.id}`, { error: error.message });
    }
}

/**
 * Send a reply to a YouTube comment thread.
 * @returns {boolean} true if reply was sent successfully, false otherwise
 */
async function sendReply(youtubeClient, parentId, textOriginal, userId) {
    try {
        await youtubeClient.comments.insert({
            part: 'snippet',
            requestBody: {
                snippet: {
                    parentId: parentId,
                    textOriginal: textOriginal
                }
            }
        });
        logger.info('YOUTUBE_WORKER', `Successfully replied to comment thread ${parentId} for user ${userId}`);
        return true;
    } catch (error) {
        logger.error('YOUTUBE_WORKER', `Failed to send reply to comment thread ${parentId}`, {
            userId,
            error: error.message,
            details: error.response?.data
        });
        return false;
    }
}

module.exports = {
    processUser
};
