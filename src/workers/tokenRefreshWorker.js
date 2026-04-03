const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const instagramService = require('../services/instagramService');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const pushNotificationService = require('../services/pushNotificationService');

/**
 * WORKER: Process single Instagram long-lived token refresh
 */
const tokenRefreshWorker = new Worker(QUEUES.TOKEN_REFRESH, async (job) => {
    const { userId, instagramId, accessToken } = job.data;

    logger.info('WORKER:TOKEN_REFRESH:START', `Processing token refresh for user ${userId}`, { jobId: job.id });

    try {
        if (!userId || !instagramId || !accessToken) {
            logger.error('WORKER:TOKEN_REFRESH:SKIP', 'Missing required data in job payload', { userId, instagramId });
            return { skipped: true, reason: 'Missing payload data' };
        }

        // 1. Call Meta API to refresh long-lived token
        const refreshData = await instagramService.refreshToken(accessToken);

        if (!refreshData || !refreshData.access_token) {
            logger.error('WORKER:TOKEN_REFRESH:API_ERROR', `Failed to refresh token from Meta API`, { userId });
            throw new Error('Meta API returned empty refresh data');
        }

        // 2. Compute new expiry (Default 60 days)
        const expiresInSeconds = parseInt(refreshData.expires_in) || 5184000;
        const newExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

        // 3. Update account record via Prisma
        await prisma.instagramAccount.update({
            where: { userId },
            data: {
                instagramAccessToken: refreshData.access_token,
                tokenExpiresAt: newExpiresAt,
                isConnected: true
            }
        });

        logger.info('WORKER:TOKEN_REFRESH:SUCCESS', `Token successfully refreshed for user ${userId}`);
        return { success: true };

    } catch (error) {
        logger.error('WORKER:TOKEN_REFRESH:FAILED', `Job failed for user ${userId}`, { 
            jobId: job.id,
            error: error.message 
        });

        // If permanent error (e.g. 190), notify user and disconnect
        const errorCode = error.response?.data?.error?.code;
        if (errorCode === 190 || error.message.includes('expired')) {
            await prisma.instagramAccount.update({
                where: { userId },
                data: { isConnected: false }
            });
            await pushNotificationService.notifyTokenExpired(userId).catch(() => {});
        }

        throw error; // Trigger BullMQ retry
    }
}, { connection, concurrency: 5 });

module.exports = { tokenRefreshWorker };
