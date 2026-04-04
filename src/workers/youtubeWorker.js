const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { acquireLock, releaseLock } = require('../utils/redisLock');
const { enqueueJob, youtubeQueue } = require('../utils/queue');
const { checkBackpressure } = require('../utils/scaling/backpressure');

// Worker runs every 1 minute
cron.schedule('* * * * *', async () => {
    const { appConfig } = require('../config');
    if (!appConfig.featureFlags.youtubeAutomationEnabled) {
        logger.debug('YOUTUBE_DISPATCHER', 'YouTube Automation is globally disabled. Skipping.');
        return;
    }

    const lockName = 'youtube_cron';
    const locked = await acquireLock(lockName, 110);

    if (!locked) {
        logger.debug('YOUTUBE_DISPATCHER', 'Cron is locked by another instance. Skipping.');
        return;
    }

    // ─── BACKPRESSURE CHECK: Avoid overloading if YouTube queue is full ───

    const pressure = await checkBackpressure(youtubeQueue, 5000); // 5k limit for polling
    if (pressure.overloaded) {
        logger.warn('YOUTUBE_DISPATCHER:BACKPRESSURE', `Skipping dispatch due to queue overload (${pressure.count} jobs)`);
        await releaseLock(lockName);
        return;
    }

    logger.info('YOUTUBE_DISPATCHER', 'Finding active YouTube users for processing');

    try {
        const usersWithYoutube = await prisma.user.findMany({
            where: {
                youtubeConnected: true,
                youtubeAccessToken: { not: null },
                youtubeRules: { some: { isActive: true } }
            },
            select: { id: true }
        });

        logger.info('YOUTUBE_DISPATCHER', `Dispatching ${usersWithYoutube.length} users to the YouTube queue`);

        if (usersWithYoutube.length === 0) {
            return logger.info('YOUTUBE_DISPATCHER', 'No active users found');
        }

        // Parallelize: Enqueue each user as a separate job
        for (const user of usersWithYoutube) {
            await enqueueJob(youtubeQueue, 'process-user', { userId: user.id })
                .catch(err => logger.error('YOUTUBE_DISPATCHER:ENQUEUE_FAIL', `Failed to enqueue user ${user.id}`, err));
        }

    } catch (error) {
        logger.error('YOUTUBE_DISPATCHER', 'Dispatcher failed', error);
    } finally {
        await releaseLock(lockName);
    }
});

logger.info('YOUTUBE_DISPATCHER', '✅ YouTube Dispatcher Cron initialized');

module.exports = {};
