const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const instagramService = require('../services/instagramService');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const pushNotificationService = require('../services/pushNotificationService');

/**
 * WORKER: Process single Instagram account analytics snapshot
 */
const analyticsWorker = new Worker(QUEUES.ANALYTICS, async (job) => {
    const { userId, instagramId, accessToken } = job.data;

    logger.info('WORKER:ANALYTICS:START', `Processing snapshot for user ${userId}`, { jobId: job.id });

    try {
        if (!userId || !instagramId || !accessToken) {
            logger.error('WORKER:ANALYTICS:SKIP', 'Missing required data in job payload', { userId, instagramId });
            return { skipped: true, reason: 'Missing payload data' };
        }

        // 1. Fetch basic stats from Instagram Graph API
        const stats = await instagramService.getAccountStats(instagramId, accessToken);

        // 2. Fetch recent media to estimate reach/impressions (last 20 posts)
        const media = await instagramService.getUserMedia(instagramId, accessToken);
        const recentMedia = media.slice(0, 20);

        let totalReach = 0;
        let totalImpressions = 0;

        for (const item of recentMedia) {
            try {
                const insights = await instagramService.getMediaInsights(item.id, accessToken, item.media_type);
                totalReach += insights.reach || 0;
                totalImpressions += insights.impressions || 0;
            } catch (err) {
                logger.warn('WORKER:ANALYTICS:INSIGHTS_ERROR', `Failed to fetch insights for media ${item.id}`, { error: err.message });
            }
        }

        // 3. Store snapshot in Prisma (MongoDB)
        // Use UTC midnight for unique daily snapshots
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        const snapshot = await prisma.analyticsSnapshot.upsert({
            where: {
                userId_snapshotDate: {
                    userId: userId,
                    snapshotDate: today
                }
            },
            create: {
                userId,
                followers: stats.followers_count || 0,
                following: stats.follows_count || 0,
                mediaCount: stats.media_count || 0,
                reach: totalReach,
                impressions: totalImpressions,
                snapshotDate: today
            },
            update: {
                followers: stats.followers_count || 0,
                following: stats.follows_count || 0,
                mediaCount: stats.media_count || 0,
                reach: totalReach,
                impressions: totalImpressions
            }
        });

        // 4. Milestone Check (Followers)
        const yesterday = new Date(today.getTime() - 86400000);
        const prevSnapshot = await prisma.analyticsSnapshot.findFirst({
            where: { userId, snapshotDate: yesterday }
        });

        const currentFollowers = stats.followers_count || 0;
        const prevFollowers = prevSnapshot ? prevSnapshot.followers : 0;

        const milestones = [100, 500, 1000, 5000, 10000, 50000, 100000];
        const milestoneHit = milestones.find(m => currentFollowers >= m && prevFollowers < m);

        if (milestoneHit) {
            await pushNotificationService.notifyAnalyticsMilestone(userId, 'Followers', milestoneHit).catch(err => 
                logger.warn('WORKER:ANALYTICS:NOTIFY_ERROR', 'Failed to send milestone notification', { error: err.message, userId })
            );
        }

        // 5. Viral Alert Check
        if (totalReach > 10000 && (!prevSnapshot || totalReach > prevSnapshot.reach * 1.5)) {
            await pushNotificationService.notifyViralAlert(userId, 'your content', totalReach).catch(err => 
                logger.warn('WORKER:ANALYTICS:NOTIFY_ERROR', 'Failed to send viral alert notification', { error: err.message, userId })
            );
        }

        // 6. Update lastSyncedAt on the account
        await prisma.instagramAccount.update({
            where: { userId },
            data: { lastSyncedAt: new Date() }
        });

        logger.info('WORKER:ANALYTICS:SUCCESS', `Snapshot completed for user ${userId}`);
        return { success: true };

    } catch (error) {
        logger.error('WORKER:ANALYTICS:FAILED', `Job failed for user ${userId}`, { 
            jobId: job.id,
            error: error.message 
        });
        throw error; // Trigger BullMQ retry
    }
}, { connection, concurrency: 5 });

module.exports = { analyticsWorker };
