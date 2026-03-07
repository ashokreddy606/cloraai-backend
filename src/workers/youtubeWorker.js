const prisma = require('../lib/prisma');
const { google } = require('googleapis');
const logger = require('../utils/logger');
const cron = require('node-cron');

const getOAuth2Client = () => {
    return new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET,
        process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5000/api/youtube/callback'
    );
};

// Worker runs every 2 minutes
cron.schedule('*/2 * * * *', async () => {
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
    }
});

async function processUser(user) {
    try {
        // Set credentials for this user
        const client = getOAuth2Client();
        client.setCredentials({
            access_token: user.youtubeAccessToken,
            refresh_token: user.youtubeRefreshToken
        });

        const youtube = google.youtube({ version: 'v3', auth: client });

        // 2. Fetch recent comment threads for the user's channel
        // We fetch a small number (e.g., 20) per cycle to handle real-time without overwhelming rate limits
        const response = await youtube.commentThreads.list({
            part: 'snippet,replies',
            allThreadsRelatedToChannelId: user.youtubeChannelId,
            maxResults: 20,
            order: 'time'
        });

        const items = response.data.items || [];

        for (const item of items) {
            const topLevelComment = item.snippet.topLevelComment.snippet;
            const commentId = item.id;
            const videoId = topLevelComment.videoId;
            const textDisplay = topLevelComment.textDisplay.toLowerCase();
            const authorDisplayName = topLevelComment.authorDisplayName;

            // Prevent replying to own comments
            if (topLevelComment.authorChannelId.value === user.youtubeChannelId) continue;

            // 3. Deduplicate: check if we already processed this comment
            const existingRecord = await prisma.youtubeComment.findUnique({
                where: { commentId }
            });

            if (existingRecord) continue; // Already known

            // Skip rule matching if it's already a saved comment to avoid double replies

            let matchedRule = null;
            for (const rule of user.youtubeRules) {
                if (textDisplay.includes(rule.keyword)) {
                    matchedRule = rule;
                    break; // First rule match wins
                }
            }

            const shouldReply = matchedRule !== null;

            // Save comment immediately
            await prisma.youtubeComment.create({
                data: {
                    userId: user.id,
                    videoId,
                    commentId,
                    username: authorDisplayName,
                    commentText: topLevelComment.textDisplay,
                    replied: shouldReply
                }
            });

            if (!shouldReply) continue;

            // 4. Rate Limiting Check (limit per hour per rule)
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

            // How many replies were made by this user in the last hour?
            // In a more complex setup, you'd match it explicitly by rule ID or track replies precisely
            // Here we just limit the user's total active replies to avoid spam flags.
            // Alternatively, store `ruleId` in `YoutubeComment` or `YoutubeAutomationEvent`
            const recentRepliesCount = await prisma.youtubeComment.count({
                where: {
                    userId: user.id,
                    replied: true,
                    createdAt: { gte: oneHourAgo }
                }
            });

            if (recentRepliesCount >= matchedRule.limitPerHour) {
                logger.info('YOUTUBE_WORKER', `Rate limit exceeded for user ${user.id} (Rule: ${matchedRule.keyword})`);
                continue; // Skip reply this round
            }

            // 5. Send Auto-Reply
            if (matchedRule.replyDelay > 0) {
                // Simple memory setTimeout for small delays (e.g. 10s-60s). 
                // For larger delays (hours), you'd need a robust job queue like BullMQ.
                setTimeout(() => {
                    sendReply(youtube, commentId, matchedRule.replyMessage, user.id);
                }, matchedRule.replyDelay * 1000);
            } else {
                await sendReply(youtube, commentId, matchedRule.replyMessage, user.id);
            }
        }
    } catch (error) {
        logger.error('YOUTUBE_WORKER', `Failed to process user ${user.id}`, error);
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
        logger.error('YOUTUBE_WORKER', `Failed to send reply to comment ${parentId}`, error);
        // You might want to update `replied: false` in database here if it fails
    }
}

module.exports = {
    processUser // Exported for manual testing if needed
};
