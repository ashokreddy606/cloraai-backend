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

// Worker runs every 2 minutes
cron.schedule('*/2 * * * *', async () => {
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
            const topLevelComment = item.snippet?.topLevelComment?.snippet;
            if (!topLevelComment) continue;

            const commentId = item.id;
            const videoId = topLevelComment.videoId;
            const textDisplay = (topLevelComment.textDisplay || '').toLowerCase();
            const authorDisplayName = topLevelComment.authorDisplayName;

            // Prevent replying to own comments
            if (topLevelComment.authorChannelId?.value === user.youtubeChannelId) continue;

            // 3. Deduplicate: check if we already processed this comment
            const existingRecord = await prisma.youtubeComment.findUnique({
                where: { commentId }
            });

            if (existingRecord) continue;

            let matchedRule = null;
            for (const rule of user.youtubeRules) {
                if (textDisplay.includes(rule.keyword.toLowerCase())) {
                    matchedRule = rule;
                    break;
                }
            }

            const shouldReply = matchedRule !== null;

            // Save comment
            await prisma.youtubeComment.create({
                data: {
                    userId: user.id,
                    videoId,
                    commentId,
                    username: authorDisplayName || 'Unknown',
                    commentText: topLevelComment.textDisplay || '',
                    replied: shouldReply
                }
            });

            if (!shouldReply) {
                logger.debug('YOUTUBE_WORKER', `Comment ${commentId} did not match any rules`);
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
            if (matchedRule.replyDelay > 0) {
                setTimeout(() => {
                    sendReply(youtube, commentId, matchedRule.replyMessage, user.id);
                }, matchedRule.replyDelay * 1000);
            } else {
                await sendReply(youtube, commentId, matchedRule.replyMessage, user.id);
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
