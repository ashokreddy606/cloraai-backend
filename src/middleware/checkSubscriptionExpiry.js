const prisma = require('../lib/prisma');
const { cache } = require('../utils/cache');

const CACHE_TTL_SECONDS = 300; // 5 minutes — balances freshness vs DB load

/**
 * Middleware to check and enforce subscription expiry.
 * 
 * Performance: Uses Redis cache (5-min TTL) to avoid hitting the DB
 * on every authenticated request. At high concurrency this eliminates
 * thousands of redundant DB queries per minute.
 * 
 * Cache key: sub:{userId}
 * Cached value: { plan, planEndDate, subscriptionStatus }
 */
const checkSubscriptionExpiry = async (req, res, next) => {
    if (!req.userId) return next();

    try {
        const cacheKey = `sub:${req.userId}`;

        // ── 1. Check Redis cache first ──────────────────────────────────
        const cached = await cache.get(cacheKey);
        if (cached) {
            // Apply cached plan state to req.user for downstream middleware
            if (req.user) {
                req.user.plan = cached.plan;
                req.user.subscriptionStatus = cached.subscriptionStatus;
            }
            return next();
        }

        // ── 2. Cache miss: query the DB ─────────────────────────────────
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { id: true, plan: true, planEndDate: true, subscriptionStatus: true }
        });

        if (!user) return next();

        let { plan, planEndDate, subscriptionStatus } = user;

        // ── 3. Enforce expiry with 3-day Grace Period ────────────────────────
        if (
            plan !== 'FREE' &&
            plan !== 'LIFETIME' &&
            planEndDate &&
            new Date(planEndDate) < new Date()
        ) {
            const expiryDate = new Date(planEndDate);
            const gracePeriodEnd = new Date(expiryDate.getTime() + (3 * 24 * 60 * 60 * 1000)); // 3 days

            // If status is PAST_DUE (failed payment), allow a 3-day window
            if (subscriptionStatus === 'PAST_DUE' && new Date() < gracePeriodEnd) {
                logger.info('GRACE_PERIOD_ACTIVE', `User ${user.id} in grace period until ${gracePeriodEnd}`);
                // Allow through
            } else {
                // Hard downgrade
                logger.info('SUBSCRIPTION_EXPIRED', `User ${user.id} plan expired. Downgrading to FREE.`);
                await prisma.user.update({
                    where: { id: user.id },
                    data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' }
                });
                plan = 'FREE';
                subscriptionStatus = 'EXPIRED';
            }
        }

        // ── 4. Populate cache for next requests ─────────────────────────
        const snapshot = { plan, planEndDate, subscriptionStatus };
        await cache.set(cacheKey, snapshot, CACHE_TTL_SECONDS);

        // Apply to req.user so downstream middleware sees updated plan
        if (req.user) {
            req.user.plan = plan;
            req.user.subscriptionStatus = subscriptionStatus;
        }

        next();
    } catch (error) {
        console.error('[SubscriptionCheck] Error:', error);
        next(); // Don't block request if check fails
    }
};

/**
 * Call this whenever a user's plan changes (subscription controller, admin controller)
 * to immediately invalidate the cache so the next request reflects the new plan.
 */
const invalidateSubscriptionCache = async (userId) => {
    try {
        await cache.del(`sub:${userId}`);
    } catch (err) {
        console.error('[SubscriptionCheck] Cache invalidation failed:', err.message);
    }
};

module.exports = checkSubscriptionExpiry;
module.exports.invalidateSubscriptionCache = invalidateSubscriptionCache;
