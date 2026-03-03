/**
 * requirePremium.js
 * Middleware: blocks access unless user has an active PRO or LIFETIME plan.
 * Reads plan from User model (single source of truth after schema migration).
 * Use this for hard-block routes — no free tier allowed at all.
 * For soft-gating with limits, use per-controller checks instead.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const requirePremium = async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: {
                id: true,
                plan: true,
                subscriptionStatus: true,
                planEndDate: true,
            },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // LIFETIME users always pass
        if (user.plan === 'LIFETIME') {
            return next();
        }

        // PRO users: must have ACTIVE or CANCELLED (grace) status and planEndDate in future
        const hasActivePro =
            user.plan === 'PRO' &&
            ['ACTIVE', 'CANCELLED'].includes(user.subscriptionStatus) &&
            user.planEndDate &&
            new Date(user.planEndDate) > new Date();

        if (hasActivePro) {
            return next();
        }

        return res.status(403).json({
            error: 'Pro Required',
            message: 'This feature requires an active Pro or Lifetime subscription.',
            code: 'PLAN_REQUIRED',
        });
    } catch (error) {
        console.error('requirePremium Error:', error);
        res.status(500).json({ error: 'Failed to verify subscription status' });
    }
};

module.exports = requirePremium;
