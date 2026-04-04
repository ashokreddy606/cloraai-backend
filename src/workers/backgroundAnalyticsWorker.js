const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const instagramService = require('../services/instagramService');
const { decrypt } = require('../utils/cryptoUtils');

/**
 * Analytics Background Worker
 * Offloads heavy Meta API calls from the main request thread.
 */

const analyticsWorker = new Worker(QUEUES.ANALYTICS, async (job) => {
    const { userId } = job.data;
    
    try {
        const account = await prisma.instagramAccount.findFirst({
            where: { userId, isConnected: true }
        });

        if (!account || !account.instagramAccessToken) return;

        const decryptedToken = decrypt(account.instagramAccessToken);
        const pToken = account.pageAccessToken ? decrypt(account.pageAccessToken) : decryptedToken;

        // 1. Fetch Basic Account Stats
        const stats = await instagramService.getAccountStats(account.instagramId, decryptedToken);

        // 2. Fetch Insights (Account Level)
        const accountInsights = await instagramService.getAccountInsights(account.instagramId, decryptedToken, 'day');
        const accountInsights30d = await instagramService.getAccountInsights(account.instagramId, pToken, 'days_28');

        let totalReach = Math.max(accountInsights.reach || 0, accountInsights30d.reach || 0);
        let totalImpressions = Math.max(accountInsights.impressions || 0, accountInsights30d.impressions || 0, totalReach);

        // 3. Fetch Media Insights (The Heavy Part)
        const media = await instagramService.getUserMedia(account.instagramId, decryptedToken);
        
        if (media && media.length > 0) {
            const topMedia = media.slice(0, 30);
            
            // View counts for videos/reels
            const videoItems = topMedia.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REELS');
            const videoPlayCounts = await Promise.all(
                videoItems.map(m => instagramService.getVideoViewCount(m.id, decryptedToken).catch(() => 0))
            );
            const directPlays = videoPlayCounts.reduce((sum, v) => sum + v, 0);

            // Insights for all top media
            const insights = await Promise.all(
                topMedia.map(m => instagramService.getMediaInsights(m.id, decryptedToken, m.media_type).catch(() => ({})))
            );
            
            const totalMediaImpressions = insights.reduce((sum, ins) => sum + (ins.impressions || 0), 0);
            const totalPlays = insights.reduce((sum, ins) => sum + (ins.plays || 0), 0) + directPlays;
            const totalMediaReach = insights.reduce((sum, ins) => sum + (ins.reach || 0), 0);
            
            totalImpressions = Math.max(totalImpressions, totalMediaImpressions, totalPlays);
            totalReach = Math.max(totalReach, totalMediaReach);
        }

        // 4. Update Snapshot
        await prisma.analyticsSnapshot.create({
            data: {
                userId,
                followers: stats.followers_count || 0,
                posts: stats.media_count || 0,
                following: stats.follows_count || 0,
                impressions: totalImpressions,
                reach: totalReach,
                snapshotDate: new Date()
            }
        });

        logger.info('ANALYTICS_WORKER', `Background refresh complete for user ${userId}`);

    } catch (error) {
        logger.error('ANALYTICS_WORKER', `Refresh failed for user ${userId}`, { error: error.message });
        throw error;
    }
}, { connection, concurrency: 5 });

module.exports = { analyticsWorker };
