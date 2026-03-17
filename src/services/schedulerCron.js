const os = require('os');
const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { encryptToken, decryptToken } = require('../utils/cryptoUtils');
const { instagramQueue, youtubeQueue } = require('../utils/queue');
const { createNotification } = require('../controllers/notificationController');
const axios = require('axios');

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PART 1: DB-Based Leader Lock for Multi-Instance Safety
// Guarantees only ONE process runs cron even in PM2 cluster mode
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const acquireLock = async (lockName) => {
    const now = new Date();
    const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS);
    try {
        // Upsert: only succeed if the lock doesn't exist OR it's stale (crashed worker)
        await prisma.cronLock.upsert({
            where: { lockName },
            create: { lockName, lockedAt: now, lockedBy: WORKER_ID },
            update: {
                // Only take over if the existing lock is stale
                lockedAt: { set: now },
                lockedBy: WORKER_ID,
            }
        });

        // Verify we actually own it (race condition check)
        const lock = await prisma.cronLock.findUnique({ where: { lockName } });
        if (!lock || lock.lockedBy !== WORKER_ID) return false;
        if (lock.lockedAt < staleThreshold) return false; // Someone else snuck in

        return true;
    } catch {
        return false;
    }
};

const releaseLock = async (lockName) => {
    try {
        await prisma.cronLock.deleteMany({
            where: { lockName, lockedBy: WORKER_ID }
        });
    } catch { /* Best-effort release */ }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Retry Logic Helper
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const handleFailure = async (postId, currentRetryCount, errorMessage, oldScheduledAt) => {
    const post = await prisma.scheduledPost.findUnique({ where: { id: postId }, select: { userId: true } });
    if (currentRetryCount >= 3) {
        logger.warn('CRON:SCHEDULER', `Post ${postId} reached max retries. Marking as failed.`);
        await prisma.scheduledPost.update({
            where: { id: postId },
            data: { status: 'failed', errorMessage: `Max retries (3) reached. Last error: ${errorMessage}` }
        });

        if (post) {
            await createNotification(post.userId, {
                type: 'error', icon: 'close-circle', color: '#EF4444',
                title: 'Post Failed', body: `Your post failed to publish: ${errorMessage}`
            }).catch(e => logger.warn('CRON:NOTIFY', e.message));
        }
    } else {
        const nextTry = new Date(oldScheduledAt || Date.now());
        nextTry.setMinutes(nextTry.getMinutes() + 15);
        logger.info('CRON:SCHEDULER', `Post ${postId} failed. Retry ${currentRetryCount + 1}/3 at ${nextTry.toISOString()}`);
        await prisma.scheduledPost.update({
            where: { id: postId },
            data: {
                status: 'scheduled',
                retryCount: currentRetryCount + 1,
                scheduledAt: nextTry,
                errorMessage: `Attempt ${currentRetryCount + 1} failed: ${errorMessage}`
            }
        });
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PART 2: Orphaned Job Recovery — runs at startup and on each cycle
// Rescues posts stuck in 'publishing' after a server crash
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const recoverOrphanedPosts = async () => {
    const orphanThreshold = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes
    try {
        const orphaned = await prisma.scheduledPost.findMany({
            where: {
                status: 'publishing',
                updatedAt: { lt: orphanThreshold }
            },
            select: { id: true }
        });

        if (orphaned.length > 0) {
            await Promise.all(
                orphaned.map(post =>
                    prisma.scheduledPost.update({
                        where: { id: post.id },
                        data: {
                            status: 'scheduled',
                            errorMessage: 'Auto-recovered: was stuck in publishing state after server restart.'
                        }
                    }).catch(e => {
                        logger.error('CRON:RECOVERY', `Failed to recover post ${post.id}`, { error: e.message });
                    })
                )
            );

            logger.warn('CRON:RECOVERY', `Recovered ${orphaned.length} orphaned post(s) stuck in 'publishing'.`);
            logger.increment('schedulerOrphansRecovered');
        }
    } catch (e) {
        logger.error('CRON:RECOVERY', 'Failed to recover orphaned posts', {
            error: e.message,
            stack: e.stack,
            dbUrl: process.env.DATABASE_URL?.split('@')[1] // Log host only for privacy
        });
        console.error('PRISMA RECOVERY ERROR:', e);
    }
};

// Run orphan recovery at startup immediately
recoverOrphanedPosts();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CRON 1: Auto-Refresh Instagram Tokens (Daily @ Midnight)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cron.schedule('0 0 * * *', async () => {
    const acquired = await acquireLock('token-refresh');
    if (!acquired) {
        logger.debug('CRON:TOKEN-REFRESH', 'Lock not acquired — another instance is running. Skipping.');
        return;
    }

    logger.info('CRON:TOKEN-REFRESH', 'Running daily Instagram Token Auto-Refresh check...');
    try {
        const thresholdDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const expiringAccounts = await prisma.instagramAccount.findMany({
            where: { isConnected: true, tokenExpiresAt: { lte: thresholdDate, gt: new Date() } }
        });

        for (const account of expiringAccounts) {
            try {
                const decryptedToken = decryptToken(account.instagramAccessToken);
                const response = await axios.get(
                    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${decryptedToken}`,
                    { timeout: 10000 }
                );
                const newToken = response.data.access_token;
                const expiresInSeconds = response.data.expires_in || 5184000;
                const expiryDate = new Date(Date.now() + expiresInSeconds * 1000);

                await prisma.instagramAccount.update({
                    where: { id: account.id },
                    data: { instagramAccessToken: encryptToken(newToken), tokenExpiresAt: expiryDate }
                });
                logger.info('CRON:TOKEN-REFRESH', `Token refreshed for user ${account.userId}`);
                logger.increment('tokenRefreshSuccess');

            } catch (err) {
                logger.error('CRON:TOKEN-REFRESH', `Failed to refresh token for user ${account.userId}`, { error: err.response?.data?.error?.message || err.message });
                logger.increment('tokenRefreshFailed');

                if (err.response?.data?.error?.code === 190) {
                    await prisma.instagramAccount.update({
                        where: { id: account.id },
                        data: { isConnected: false }
                    });
                    logger.warn('CRON:TOKEN-REFRESH', `User ${account.userId} app deauthorized (Error 190). Account disconnected.`);
                }
            }
        }
    } catch (e) {
        logger.error('CRON:TOKEN-REFRESH', 'Worker-level failure', { error: e.message });
    } finally {
        await releaseLock('token-refresh');
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CRON 2: Publish Scheduled Posts (Every 15 minutes)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let schedulerTasks = [];

const schedulerJob = cron.schedule('*/15 * * * *', async () => {
    const acquired = await acquireLock('scheduler');
    if (!acquired) {
        logger.debug('CRON:SCHEDULER', 'Lock not acquired — another instance is running. Skipping.');
        return;
    }

    // Run orphan recovery on each cycle too
    await recoverOrphanedPosts();

    try {
        const now = new Date();
        const pendingPosts = await prisma.scheduledPost.findMany({
            where: { status: 'scheduled', scheduledAt: { lte: now } },
        });

        if (pendingPosts.length === 0) {
            await releaseLock('scheduler');
            return;
        }

        logger.info('CRON:SCHEDULER', `Found ${pendingPosts.length} post(s) ready to publish.`);

        const igJobs = [];
        const ytJobs = [];

        for (const post of pendingPosts) {
            // Atomic row lock
            const updated = await prisma.scheduledPost.updateMany({
                where: { id: post.id, status: 'scheduled' },
                data: { status: 'publishing' }
            });
            if (updated.count === 0) continue;

            if (post.platform === 'instagram') {
                igJobs.push({ name: 'publish', data: { postId: post.id } });
            } else if (post.platform === 'youtube') {
                ytJobs.push({ name: 'upload', data: { postId: post.id } });
            }
        }

        // Bulk Queue Optimization (Step 6)
        if (igJobs.length > 0) {
            await instagramQueue.addBulk(igJobs);
            logger.info('CRON:SCHEDULER', `Enqueued ${igJobs.length} Instagram jobs.`);
        }
        if (ytJobs.length > 0) {
            await youtubeQueue.addBulk(ytJobs);
            logger.info('CRON:SCHEDULER', `Enqueued ${ytJobs.length} YouTube jobs.`);
        }

    } catch (error) {
        logger.error('CRON:SCHEDULER', 'Worker-level failure', { error: error.message });
    } finally {
        await releaseLock('scheduler');
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CRON 3: Subscription Expiration Reminders (Daily @ 10 AM)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const subscriptionReminderJob = cron.schedule('0 10 * * *', async () => {
    const acquired = await acquireLock('subscription-reminder');
    if (!acquired) return;

    logger.info('CRON:SUB-REMINDER', 'Running daily subscription expiration check...');
    try {
        const now = new Date();
        const twoDaysFromNow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
        const twoDaysPlusOneHour = new Date(twoDaysFromNow.getTime() + 60 * 60 * 1000);

        // Find users with PRO/LIFETIME plan expiring in ~48 hours
        // We look for users whose planEndDate is within a 1-hour window to avoid duplicates if run multiple times
        // though the cron is set to run once per day.
        const expiringUsers = await prisma.user.findMany({
            where: {
                plan: { in: ['PRO'] },
                subscriptionStatus: 'ACTIVE',
                planEndDate: {
                    gte: twoDaysFromNow,
                    lte: twoDaysPlusOneHour,
                },
                pushToken: { not: null },
            },
            select: { id: true, pushToken: true, planEndDate: true },
        });

        if (expiringUsers.length === 0) {
            logger.info('CRON:SUB-REMINDER', 'No subscriptions expiring in 2 days.');
            return;
        }

        logger.info('CRON:SUB-REMINDER', `Found ${expiringUsers.length} user(s) to notify.`);

        const pushService = require('./pushNotificationService');
        await Promise.allSettled(
            expiringUsers.map((user) =>
                pushService.notifySubscriptionRenewal(user.pushToken, 2).catch((e) =>
                    logger.warn('CRON:SUB-REMINDER', `Failed to notify user ${user.id}: ${e.message}`)
                )
            )
        );

    } catch (error) {
        logger.error('CRON:SUB-REMINDER', 'Worker-level failure', { error: error.message });
    } finally {
        await releaseLock('subscription-reminder');
    }
});

schedulerTasks.push(schedulerJob, subscriptionReminderJob);

logger.info('CRON', 'Scheduler and Token-Refresh cron jobs initialized.', { workerId: WORKER_ID });

// Export for graceful shutdown
module.exports = { schedulerTasks, releaseLock };
