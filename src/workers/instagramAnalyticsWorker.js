const cron = require('node-cron');
const InstagramAccount = require('../../models/InstagramAccount');
const instagramService = require('../services/instagramService');
const InstagramAnalytics = require('../../models/InstagramAnalytics');
const { decryptToken } = require('../utils/cryptoUtils');
const logger = require('../utils/logger');

/**
 * Task to perform daily Instagram analytics snapshots
 */
const performDailySnapshots = async () => {
    logger.info('WORKER', 'Starting daily Instagram analytics snapshot task...');

    try {
        // 1. Get all connected Instagram accounts (from Mongoose)
        const accounts = await InstagramAccount.find();

        logger.info('WORKER', `Found ${accounts.length} connected Instagram accounts to process.`);

        for (const account of accounts) {
            try {
                // Ensure token is decrypted explicitly if needed
                const accessToken = account.instagramAccessToken;

                // 2. Fetch basic stats
                const stats = await instagramService.getAccountStats(account.instagramId, accessToken);

                // 3. Fetch recent media to estimate reach/impressions (last 20 posts for better coverage)
                const media = await instagramService.getUserMedia(account.instagramId, accessToken);
                const recentMedia = media.slice(0, 20);

                let totalReach = 0;
                let totalImpressions = 0;

                for (const item of recentMedia) {
                    const insights = await instagramService.getMediaInsights(item.id, accessToken, item.media_type);
                    totalReach += insights.reach || 0;
                    totalImpressions += insights.impressions || 0;
                }

                // 4. Store snapshot in Mongoose
                // Use a date without time for unique daily snapshots
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                await InstagramAnalytics.findOneAndUpdate(
                    { userId: account.userId, date: today },
                    {
                        followers: stats.followers_count,
                        posts: stats.media_count,
                        reach: totalReach,
                        impressions: totalImpressions
                    },
                    { upsert: true, new: true }
                );

                logger.info('WORKER', `Snapshot saved for user ${account.userId}`);
            } catch (error) {
                logger.error('WORKER', `Failed to process snapshot for user ${account.userId}:`, { error: error.message });
            }
        }
    } catch (error) {
        logger.error('WORKER', 'Critical error in Instagram analytics worker:', { error: error.message });
    }
};

// Schedule the task to run every 24 hours at midnight
cron.schedule('0 0 * * *', performDailySnapshots);

// Export for manual trigger if needed
module.exports = { performDailySnapshots };
