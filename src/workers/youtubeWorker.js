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
    // Acquire lock for 110s (slightly less than the 2 min interval)
    // so if a worker crashes, the lock will still expire before the next schedule
    const locked = await acquireLock(lockName, 110);

    if (!locked) {
        logger.debug('YOUTUBE_WORKER', 'Cron is locked by another instance. Skipping.');
        return;
    }

    logger.info('YOUTUBE_WORKER', 'Starting YouTube background worker to fetch comments');

    try {
        // 1. Fetch all users who have connected their YouTube and have active rules
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
        // Release the lock when done so other instances aren't blocked from the next scheduled hit
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
        // Automatically refresh if expired
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

async function processUser(user) {
    let youtube;
    try {
        youtube = await getYoutubeClient(user);
        logger.debug('YOUTUBE_WORKER', `Processing user ${user.id}`, { channelId: user.youtubeChannelId });

        const response = await youtube.commentThreads.list({
            part: 'snippet,replies',
            allThreadsRelatedToChannelId: user.youtubeChannelId,
            maxResults: 20,
            order: 'time'
        });

        const items = response.data.items || [];
        if (items.length === 0) {
            logger.debug('YOUTUBE_WORKER', `No new comments for user ${user.id}`);
            return;
        }

        for (const item of items) {
            const topLevelComment = item.snippet?.topLevelComment;
            if (!topLevelComment) continue;

            const threadId = item.id;
            const commentId = topLevelComment.id; // Use the actual comment ID, not the thread ID, to prevent duplicate processing
            const videoId = topLevelComment.snippet?.videoId || item.snippet?.videoId;
            const textDisplay = (topLevelComment.snippet?.textDisplay || '').toLowerCase();
            const authorDisplayName = topLevelComment.snippet?.authorDisplayName;

            // Prevent replying to own comments
            if (topLevelComment.snippet?.authorChannelId?.value === user.youtubeChannelId) continue;

            // 3. Deduplicate: check if we already processed this comment
            const existingRecord = await prisma.youtubeComment.findUnique({
                where: { commentId }
            });

            if (existingRecord) {
                logger.debug('YOUTUBE_WORKER', `Comment already processed: ${commentId}. Skipping.`);
                continue;
            }

            // 2. Keyword Matching
            let matchedRule = user.youtubeRules.find(r => r.videoId === videoId && textDisplay.includes(r.keyword.toLowerCase()));
            if (!matchedRule) {
                matchedRule = user.youtubeRules.find(r => !r.videoId && textDisplay.includes(r.keyword.toLowerCase()));
            }

            if (!matchedRule) {
                continue; // Ignore the comment if no keyword match
            }

            logger.info('YOUTUBE_WORKER', `Keyword match: "${matchedRule.keyword}" in comment ${commentId}`);

            const authorChannelId = topLevelComment.snippet?.authorChannelId?.value;
            let finalShouldReply = true;

            // 4. Check onlySubscribers toggle
            if (matchedRule.onlySubscribers) {
                if (authorChannelId) {
                    try {
                        const subRes = await youtube.subscriptions.list({
                            part: 'snippet',
                            channelId: authorChannelId, 
                            forChannelId: user.youtubeChannelId 
                        });
                        
                        const isSubscribed = (subRes.data.items || []).length > 0;
                        if (!isSubscribed) {
                            logger.info('YOUTUBE_WORKER', `User skipped: Author ${authorChannelId} is not subscribed to channel ${user.youtubeChannelId}. Skipping reply.`);
                            finalShouldReply = false;
                        }
                    } catch (apiError) {
                        logger.warn('YOUTUBE_WORKER', `User skipped: Could not verify subscription for ${authorChannelId} (likely private)`, { error: apiError.message });
                        finalShouldReply = false;
                    }
                } else {
                    logger.warn('YOUTUBE_WORKER', `Missing authorChannelId for comment ${commentId}. Skipping.`);
                    finalShouldReply = false;
                }
            }

            // Save comment
            await prisma.youtubeComment.create({
                data: {
                    userId: user.id,
                    channelId: user.youtubeChannelId,
                    videoId,
                    commentId, // unique top-level comment ID for accurate deduplication
                    username: authorDisplayName || 'Unknown',
                    commentText: topLevelComment.textDisplay || '',
                    replied: finalShouldReply
                }
            });

            if (!finalShouldReply) {
                if (matchedRule.onlySubscribers) {
                    logger.debug('YOUTUBE_WORKER', `Comment ${commentId} skipped because user is not a subscriber`);
                } else {
                    logger.debug('YOUTUBE_WORKER', `Comment ${commentId} did not match any rules`);
                }
                continue;
            }

            logger.info('YOUTUBE_WORKER', `Matched rule "${matchedRule.keyword}" for comment ${commentId}`);

            // 4. Rate Limiting Check
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
                continue;
            }

            // 5. Send Auto-Reply
            const { appConfig } = require('../config');
            if (!appConfig.featureFlags.youtubeCommentRepliesEnabled) {
                logger.debug('YOUTUBE_WORKER', 'Comment replies are globally disabled. Skipping reply.');
                continue;
            }

            let finalMessage = matchedRule.replyMessage;
            if (matchedRule.appendLinks) {
                const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
                if (links.length > 0) {
                    finalMessage += '\n\n' + links.join('\n');
                }
            }

            if (matchedRule.replyDelay > 0) {
                setTimeout(() => {
                    sendReply(youtube, threadId, finalMessage, user.id);
                }, matchedRule.replyDelay * 1000);
            } else {
                await sendReply(youtube, threadId, finalMessage, user.id);
            }
        }
    } catch (error) {
        logger.error('YOUTUBE_WORKER', `Failed to process user ${user.id}`, { error: error.message });
    }
}

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
        logger.info('YOUTUBE_WORKER', `Successfully replied to comment ${parentId} for user ${userId}`);
    } catch (error) {
        logger.error('YOUTUBE_WORKER', `Failed to send reply to comment ${parentId}`, {
            userId,
            error: error.message,
            details: error.response?.data
        });
    }
}

module.exports = {
    processUser
};
