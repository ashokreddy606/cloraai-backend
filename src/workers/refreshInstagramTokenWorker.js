const cron = require('node-cron');
const InstagramAccount = require('../../models/InstagramAccount');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');

/**
 * Worker to refresh Instagram long-lived tokens
 * Long-lived tokens expire in 60 days. We refresh them every 50 days.
 */
const refreshTokens = async () => {
    logger.info('WORKER', 'Starting Instagram token refresh task...');

    try {
        // Find tokens that expire in the next 15 days or are already expired
        const fifteenDaysFromNow = new Date();
        fifteenDaysFromNow.setDate(fifteenDaysFromNow.getDate() + 15);

        const accountsToRefresh = await InstagramAccount.find({
            tokenExpiresAt: { $lte: fifteenDaysFromNow }
        });

        logger.info('WORKER', `Found ${accountsToRefresh.length} accounts needing token refresh.`);

        for (const account of accountsToRefresh) {
            try {
                const refreshData = await instagramService.refreshToken(account.accessToken);

                const newExpiresAt = new Date();
                newExpiresAt.setSeconds(newExpiresAt.getSeconds() + refreshData.expires_in);

                account.accessToken = refreshData.access_token;
                account.tokenExpiresAt = newExpiresAt;
                await account.save();

                logger.info('WORKER', `Token refreshed for user ${account.userId}`);
            } catch (error) {
                logger.error('WORKER', `Failed to refresh token for user ${account.userId}:`, { error: error.message });
            }
        }
    } catch (error) {
        logger.error('WORKER', 'Critical error in Instagram token refresh worker:', { error: error.message });
    }
};

// Run every day at 1:00 AM to check for expiring tokens
cron.schedule('0 1 * * *', refreshTokens);

module.exports = { refreshTokens };
