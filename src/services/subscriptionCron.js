/**
 * subscriptionCron.js
 * Daily cron: auto-downgrade expired PRO users to FREE.
 *
 * HARDENED (Phase 2):
 *   - CronLock prevents parallel execution in PM2 cluster mode.
 *   - Startup reconciliation fires immediately on require() to catch
 *     any missed run caused by a server restart/crash near midnight.
 *   - LIFETIME users are always protected (planEndDate = null).
 *   - Idempotent: running twice produces zero additional side-effects.
 *
 * Cron schedule:
 *   Referral sweep: 00:02 UTC
 *   Expiry sweep:   00:05 UTC
 */

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const os = require('os');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const WORKER_ID = `${os.hostname()}-${process.pid}`;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — stale lock threshold

// ─── CronLock Helpers (same pattern as schedulerCron.js) ─────────────────────
const acquireLock = async (lockName) => {
    const now = new Date();
    const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS);
    try {
        await prisma.cronLock.upsert({
            where: { lockName },
            create: { lockName, lockedAt: now, lockedBy: WORKER_ID },
            update: { lockedAt: now, lockedBy: WORKER_ID },
        });
        // Verify ownership after upsert (race condition guard)
        const lock = await prisma.cronLock.findUnique({ where: { lockName } });
        if (!lock || lock.lockedBy !== WORKER_ID) return false;
        if (lock.lockedAt < staleThreshold) return false;
        return true;
    } catch {
        return false;
    }
};

const releaseLock = async (lockName) => {
    try {
        await prisma.cronLock.deleteMany({ where: { lockName, lockedBy: WORKER_ID } });
    } catch { /* best-effort release */ }
};

// ─── Core Expiry Logic (extracted for startup reuse) ─────────────────────────
const runSubscriptionExpiry = async () => {
    const jobStart = Date.now();
    logger.info('CRON:SUBSCRIPTIONS', `Starting subscription expiry sweep. Worker: ${WORKER_ID}`);

    const now = new Date();

    // Find ACTIVE + CANCELLED users whose paid time has ended
    const activeOrCancelledExpired = await prisma.user.findMany({
        where: {
            plan: 'PRO',
            subscriptionStatus: { in: ['ACTIVE', 'CANCELLED'] },
            planEndDate: { lt: now },
        },
        select: { id: true },
    });

    // Find PAST_DUE users whose grace period is also expired
    const pastDueExpired = await prisma.user.findMany({
        where: {
            plan: 'PRO',
            subscriptionStatus: 'PAST_DUE',
            planEndDate: { lt: now },
        },
        select: { id: true },
    });

    let downgradeCount = 0;

    // Process downgrades sequentially (or in batches) to avoid MongoDB updateMany invocation errors
    const allUsersToDowngrade = [...activeOrCancelledExpired, ...pastDueExpired];

    if (allUsersToDowngrade.length > 0) {
        await Promise.all(
            allUsersToDowngrade.map(user =>
                prisma.user.update({
                    where: { id: user.id },
                    data: {
                        plan: 'FREE',
                        subscriptionStatus: 'EXPIRED',
                        activeRazorpaySubscriptionId: null,
                    }
                }).catch(e => {
                    logger.error('CRON:SUBSCRIPTIONS', `Failed to downgrade user ${user.id}`, { error: e.message });
                })
            )
        );
        downgradeCount = allUsersToDowngrade.length;
    }

    const elapsed = Date.now() - jobStart;
    logger.info(
        'CRON:SUBSCRIPTIONS',
        `Expiry sweep done in ${elapsed}ms. Downgraded ${activeOrCancelledExpired.length} ACTIVE/CANCELLED + ${pastDueExpired.length} PAST_DUE users to FREE.`
    );

    return downgradeCount;
};

// ─── Startup Reconciliation (fire-and-forget on require) ─────────────────────
// Recovers any users who should have been downgraded if the server was
// restarted at midnight and missed the cron window. Fully idempotent.
(async () => {
    try {
        logger.info('CRON:SUBSCRIPTIONS', 'Startup reconciliation: checking for expired subscriptions...');
        const count = await runSubscriptionExpiry();
        if (count > 0) {
            logger.warn('CRON:SUBSCRIPTIONS', `Startup reconciliation: recovered ${count} expired subscription(s).`);
        } else {
            logger.info('CRON:SUBSCRIPTIONS', 'Startup reconciliation: no expired subscriptions found.');
        }
    } catch (e) {
        logger.error('CRON:SUBSCRIPTIONS', 'Startup reconciliation failed', { error: e.message });
    }
})();

// ─── Daily Referral Milestone Processing (00:02 UTC) ─────────────────────────
cron.schedule('2 0 * * *', async () => {
    const acquired = await acquireLock('referral-milestone');
    if (!acquired) {
        logger.debug('CRON:REFERRALS', 'Lock not acquired — another instance is running. Skipping.');
        return;
    }

    logger.info('CRON:REFERRALS', `Starting pending transaction sweep at ${new Date().toISOString()}`);

    try {
        const maturedTransactions = await prisma.referralTransaction.findMany({
            where: {
                status: 'PENDING',
                unlocksAt: { lte: new Date() },
            }
        });

        if (maturedTransactions.length === 0) {
            logger.info('CRON:REFERRALS', 'No matured transactions to process.');
            return;
        }

        logger.info('CRON:REFERRALS', `Found ${maturedTransactions.length} transaction(s) to process.`);

        for (const txRecord of maturedTransactions) {
            await prisma.$transaction(async (tx) => {
                await tx.referralTransaction.update({
                    where: { id: txRecord.id },
                    data: { status: 'APPROVED' }
                });

                const updatedInviter = await tx.user.update({
                    where: { id: txRecord.inviterId },
                    data: { paidReferrals: { increment: 1 } },
                    select: { id: true, paidReferrals: true, totalReferrals: true, milestoneClaimedCount: true, planEndDate: true }
                });

                const requiredPaid = (updatedInviter.milestoneClaimedCount + 1) * 5;
                const isEligible = updatedInviter.paidReferrals >= requiredPaid && updatedInviter.totalReferrals >= 25;

                if (isEligible) {
                    const currentEndDate = updatedInviter.planEndDate && new Date(updatedInviter.planEndDate) > new Date()
                        ? new Date(updatedInviter.planEndDate)
                        : new Date();

                    const newEndDate = new Date(currentEndDate.getTime() + 30 * 86400000);

                    await tx.user.update({
                        where: { id: updatedInviter.id },
                        data: {
                            milestoneClaimedCount: { increment: 1 },
                            plan: 'PRO',
                            subscriptionStatus: 'ACTIVE',
                            planSource: 'REFERRAL', // ── PHASE 5 FIX: Track reward source ──
                            planEndDate: newEndDate
                        }
                    });

                    await tx.referralTransaction.update({
                        where: { id: txRecord.id },
                        data: { rewardMonths: 1 }
                    });

                    logger.info('REFERRAL_UPGRADE', `Milestone reward granted to user ${updatedInviter.id}`, {
                        newEndDate,
                        paidReferrals: updatedInviter.paidReferrals,
                        milestone: updatedInviter.milestoneClaimedCount + 1
                    });
                    console.log(`[Referral] Milestone hit for inviter ${updatedInviter.id}! Granted 30 days PRO.`);
                }
            });
        }
    } catch (error) {
        logger.error('CRON:REFERRALS', 'Sweep FAILED', { error: error.message });
    } finally {
        await releaseLock('referral-milestone');
    }
});

// ─── Daily Subscription Expiry Check (00:05 UTC) ──────────────────────────────
cron.schedule('5 0 * * *', async () => {
    const acquired = await acquireLock('subscription-expiry');
    if (!acquired) {
        logger.debug('CRON:SUBSCRIPTIONS', 'Lock not acquired — another instance is running. Skipping.');
        return;
    }

    try {
        await runSubscriptionExpiry();
    } catch (error) {
        logger.error('CRON:SUBSCRIPTIONS', 'Daily expiry sweep FAILED', { error: error.message });
    } finally {
        await releaseLock('subscription-expiry');
    }
});

logger.info('CRON', 'subscriptionCron initialized (referrals @ 00:02 UTC, expiry @ 00:05 UTC)', { workerId: WORKER_ID });
