const prisma = require('../lib/prisma');

/**
 * Middleware to check and enforce subscription expiry.
 * Automatically downgrades user to FREE if planEndDate is in the past.
 */
const checkSubscriptionExpiry = async (req, res, next) => {
    if (!req.userId) return next();

    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { id: true, plan: true, planEndDate: true, subscriptionStatus: true }
        });

        if (
            user &&
            user.plan !== 'FREE' &&
            user.planEndDate &&
            new Date(user.planEndDate) < new Date()
        ) {
            console.log(`[SubscriptionCheck] Downgrading User ${user.id} - Plan expired on ${user.planEndDate}`);

            await prisma.user.update({
                where: { id: user.id },
                data: {
                    plan: 'FREE',
                    subscriptionStatus: 'EXPIRED'
                }
            });

            // Update local req user object if it exists
            if (req.user) {
                req.user.plan = 'FREE';
                req.user.subscriptionStatus = 'EXPIRED';
            }
        }

        next();
    } catch (error) {
        console.error('[SubscriptionCheck] Error:', error);
        next(); // Don't block request if check fails
    }
};

module.exports = checkSubscriptionExpiry;
