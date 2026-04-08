const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const instagramService = require('../services/instagramService');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const pushNotificationService = require('../services/pushNotificationService');
const { config } = require('../utils/tierConfig');
const { cache } = require('../utils/cache');
const { decrypt } = require('../utils/cryptoUtils');

/**
 * WORKER: Process single Instagram account analytics snapshot
 * ✅ PERF: Split into Fast Sync (basic stats) and Deep Sync (media insights).
 * This prevents 21+ API calls per user from destroying the quota at scale.
 */
const analyticsWorker = new Worker(QUEUES.ANALYTICS, async (job) => {
    const { userId, instagramId, accessToken, syncType = 'fast' } = job.data;

    logger.info('WORKER:ANALYTICS:START', `Processing ${syncType} snapshot for user ${userId}`, { jobId: job.id });

    try {
        if (!userId || !instagramId || !accessToken) {
            logger.error('WORKER:ANALYTICS:SKIP', 'Missing required data in job payload', { userId, instagramId });
            return { skipped: true, reason: 'Missing payload data' };
        }

        // ─── FAST SYNC (every 4h): 1 API call ────────────────────────────────
        const decryptedToken = decrypt(accessToken);
        if (!decryptedToken) {
            logger.error('WORKER:ANALYTICS:DECRYPT_ERROR', 'Failed to decrypt token', { userId });
            return { skipped: true, reason: 'Decryption failed' };
        }
        
        const stats = await instagramService.getAccountStats(instagramId, decryptedToken);

        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        // Milestone Check before deep sync (uses only basic stats)
        const yesterday = new Date(today.getTime() - 86400000);
        const prevSnapshot = await prisma.analyticsSnapshot.findFirst({
            where: { userId, snapshotDate: yesterday },
            select: { followers: true, reach: true }  // ✅ PERF: Only select needed fields
        });

        const currentFollowers = stats.followers_count || 0;
        const prevFollowers = prevSnapshot?.followers || 0;

        const milestones = [100, 500, 1000, 5000, 10000, 50000, 100000];
        const milestoneHit = milestones.find(m => currentFollowers >= m && prevFollowers < m);
        if (milestoneHit) {
            await pushNotificationService.notifyAnalyticsMilestone(userId, 'Followers', milestoneHit).catch(err =>
                logger.warn('WORKER:ANALYTICS:NOTIFY_ERROR', 'Failed to send milestone notification', { error: err.message })
            );
        }

        // ─── DEEP SYNC (every 24h or viral event): Top N posts ───────────────
        let totalReach = prevSnapshot?.reach || 0;
        let totalImpressions = 0;

        if (syncType === 'deep') {
            // ✅ FIX: Was fetching 20 posts with individual API calls each (21 calls)
            // Now: only fetch TOP 5 most recent posts (6 calls max for deep sync)
            const media = await instagramService.getUserMedia(instagramId, decryptedToken);
            const topMedia = media.slice(0, 5);

            // ✅ PERF: Parallel insight fetching instead of sequential loop
            const insightResults = await Promise.allSettled(
                topMedia.map(item => instagramService.getMediaInsights(item.id, decryptedToken, item.media_type))
            );

            for (const result of insightResults) {
                if (result.status === 'fulfilled') {
                    totalReach += result.value.reach || 0;
                    totalImpressions += result.value.impressions || 0;
                }
            }

            // ✅ Viral Alert Check
            if (totalReach > 10000 && (!prevSnapshot || totalReach > prevSnapshot.reach * 1.5)) {
                await pushNotificationService.notifyViralAlert(userId, 'your content', totalReach).catch(err =>
                    logger.warn('WORKER:ANALYTICS:NOTIFY_ERROR', 'Failed to send viral alert', { error: err.message })
                );
            }
        }

        // Persist snapshot
        await prisma.analyticsSnapshot.upsert({
            where: { userId_snapshotDate: { userId, snapshotDate: today } },
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
                ...(syncType === 'deep' ? { reach: totalReach, impressions: totalImpressions } : {})
            }
        });

        // Update lastSyncedAt with a single targeted update
        await prisma.instagramAccount.updateMany({
            where: { userId, instagramId },
            data: { lastSyncedAt: new Date() }
        });

        // ✅ Bust the user's cached plan/account so next request reflects fresh data
        await cache.clearPattern(`ig_account:${instagramId}`);

        logger.info('WORKER:ANALYTICS:SUCCESS', `${syncType} snapshot completed for user ${userId}`);
        return { success: true, syncType };

    } catch (error) {
        logger.error('WORKER:ANALYTICS:FAILED', `Job failed for user ${userId}`, {
            jobId: job.id,
            error: error.message
        });
        throw error;
    }
}, {
    connection,
    concurrency: config.concurrency.analytics  // ✅ Tier-aware concurrency
});

module.exports = { analyticsWorker };
