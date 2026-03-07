/**
 * planGuard.js
 * Feature-lock middleware for CloraAI plan tiers.
 *
 * Guards:
 *  requirePro               — allows PRO or LIFETIME with ACTIVE status
 *  requireLifetime          — allows only LIFETIME users
 *  requireActiveSubscription — allows any active paid subscriber (PRO or LIFETIME)
 *
 * Usage in routes:
 *   const { requirePro } = require('../middleware/planGuard');
 *   router.post('/generate', authenticate, requirePro, captionController.generate);
 */

const prisma = require('../lib/prisma');

// ─── Core Plan Check Helper ──────────────────────────────────────────────────
const getUserPlanData = async (userId) => {
    return prisma.user.findUnique({
        where: { id: userId },
        select: {
            plan: true,
            subscriptionStatus: true,
            planEndDate: true,
            role: true,
        },
    });
};

const isBlocked = (role) => role === 'SUSPENDED' || role === 'BANNED';

const isActiveNonLifetime = (user) => {
    if (user.plan === 'LIFETIME') return true;
    // ACTIVE: normal paid access
    // CANCELLED: user cancelled but paid up to planEndDate — grace access until then
    if (!['ACTIVE', 'CANCELLED'].includes(user.subscriptionStatus)) return false;
    if (!user.planEndDate) return false;
    return new Date(user.planEndDate) > new Date();
};

// ─── requirePro ─────────────────────────────────────────────────────────────
/**
 * Blocks FREE users from accessing Pro features.
 * Allows: PRO (with active + non-expired), LIFETIME
 * Returns 403 with upgrade prompt for FREE users.
 */
const requirePro = async (req, res, next) => {
    try {
        const user = await getUserPlanData(req.userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (isBlocked(user.role)) {
            return res.status(403).json({
                error: 'Account suspended',
                message: 'Your account has been suspended. Contact support.',
            });
        }

        if (user.plan === 'LIFETIME') return next();

        if (user.plan === 'PRO' && isActiveNonLifetime(user)) return next();

        return res.status(403).json({
            error: 'Pro plan required',
            message: 'Upgrade to Pro to access this feature',
            code: 'UPGRADE_REQUIRED',
            currentPlan: user.plan,
        });
    } catch (error) {
        console.error('[requirePro] Error:', error.message);
        res.status(500).json({ error: 'Failed to verify plan status' });
    }
};

// ─── requireLifetime ─────────────────────────────────────────────────────────
/**
 * Only LIFETIME plan holders may pass.
 */
const requireLifetime = async (req, res, next) => {
    try {
        const user = await getUserPlanData(req.userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (isBlocked(user.role)) {
            return res.status(403).json({
                error: 'Account suspended',
                message: 'Your account has been suspended. Contact support.',
            });
        }

        if (user.plan === 'LIFETIME') return next();

        return res.status(403).json({
            error: 'Lifetime plan required',
            message: 'This feature is exclusive to Lifetime plan members',
            code: 'LIFETIME_REQUIRED',
            currentPlan: user.plan,
        });
    } catch (error) {
        console.error('[requireLifetime] Error:', error.message);
        res.status(500).json({ error: 'Failed to verify plan status' });
    }
};

// ─── requireActiveSubscription ───────────────────────────────────────────────
/**
 * Blocks access if a user has no active paid subscription (expired counts as blocked).
 * Allows: PRO (active + non-expired), LIFETIME
 */
const requireActiveSubscription = async (req, res, next) => {
    try {
        const user = await getUserPlanData(req.userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (isBlocked(user.role)) {
            return res.status(403).json({
                error: 'Account suspended',
                message: 'Your account has been suspended. Contact support.',
            });
        }

        if (user.plan === 'LIFETIME') return next();
        if (user.plan === 'PRO' && isActiveNonLifetime(user)) return next();

        const isExpired = user.plan === 'PRO' && user.subscriptionStatus === 'EXPIRED';

        return res.status(403).json({
            error: isExpired ? 'Subscription expired' : 'Active subscription required',
            message: isExpired
                ? 'Your Pro plan has expired. Renew to continue using this feature.'
                : 'Upgrade to Pro to access this feature',
            code: isExpired ? 'SUBSCRIPTION_EXPIRED' : 'UPGRADE_REQUIRED',
            currentPlan: user.plan,
        });
    } catch (error) {
        console.error('[requireActiveSubscription] Error:', error.message);
        res.status(500).json({ error: 'Failed to verify subscription status' });
    }
};

module.exports = {
    requirePro,
    requireLifetime,
    requireActiveSubscription,
};
