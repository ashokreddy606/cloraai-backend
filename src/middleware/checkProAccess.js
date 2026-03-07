/**
 * checkProAccess Middleware for CloraAI
 * Blocks users who don't have an active PRO or LIFETIME plan.
 */

const prisma = require('../lib/prisma');

const checkProAccess = async (req, res, next) => {
    try {
        const userId = req.userId; // Provided by authMiddleware
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                plan: true,
                planEndDate: true
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const now = new Date();

        // Check plan type
        const isPro = user.plan === 'PRO';
        const isLifetime = user.plan === 'LIFETIME';

        // Check expiry for PRO plans (LIFETIME never expires)
        const hasActiveSubscription = isLifetime || (isPro && user.planEndDate && new Date(user.planEndDate) > now);

        if (!hasActiveSubscription) {
            return res.status(403).json({
                success: false,
                message: "Upgrade to PRO to access this premium feature",
                code: "PREMIUM_ACCESS_REQUIRED"
            });
        }

        // User is authorized
        next();
    } catch (error) {
        console.error('[AccessGuard] Error:', error);
        res.status(500).json({ error: 'Internal server error while checking access' });
    }
};

module.exports = checkProAccess;
