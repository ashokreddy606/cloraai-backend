/**
 * src/services/SubscriptionService.js
 * SaaS Lifecycle Engine
 */

const prisma = require('../lib/prisma');
const logger = require('../utils/logger');

class SubscriptionService {
    /**
     * Audit Log Helper
     */
    async logAction(adminId, targetId, action, before, after) {
        return prisma.auditLog.create({
            data: {
                adminId,
                targetId,
                action,
                details: JSON.stringify({ before, after })
            }
        });
    }

    /**
     * Admin Override: Pause Subscription
     * Temporarily blocks access without cancelling the recurring billing (Manual action).
     */
    async pauseSubscription(adminId, userId) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error('User not found');

        const updated = await prisma.user.update({
            where: { id: userId },
            data: { 
                subscriptionStatus: 'PAUSED',
                pausedAt: new Date()
            }
        });

        await this.logAction(adminId, userId, 'PAUSE_SUBSCRIPTION', 'ACTIVE', 'PAUSED');
        return updated;
    }

    /**
     * Admin Override: Resume Subscription
     */
    async resumeSubscription(adminId, userId) {
        const updated = await prisma.user.update({
            where: { id: userId },
            data: { 
                subscriptionStatus: 'ACTIVE',
                pausedAt: null
            }
        });

        await this.logAction(adminId, userId, 'RESUME_SUBSCRIPTION', 'PAUSED', 'ACTIVE');
        return updated;
    }

    /**
     * Safe Downgrade to Free
     * Cancels the active subscription and moves the user to FREE plan immediately.
     */
    async forceFree(adminId, userId) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error('User not found');

        const updated = await prisma.user.update({
            where: { id: userId },
            data: {
                plan: 'FREE',
                subscriptionStatus: 'EXPIRED',
                planEndDate: new Date(),
                razorpaySubscriptionId: null
            }
        });

        await this.logAction(adminId, userId, 'FORCE_FREE_PLAN', user.plan, 'FREE');
        return updated;
    }

    /**
     * Handle Subscription Expiry
     * Typically called by CRON job when planEndDate is reached.
     */
    async processExpiry(userId) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.plan === 'FREE') return;

        // If it's a manual upgrade from admin, don't auto-renew
        if (user.manuallyUpgraded) {
            await prisma.user.update({
                where: { id: userId },
                data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' }
            });
            logger.info('SUBSCRIPTION_EXPIRED_ADMIN', `Manual grant for ${userId} expired.`);
        }
    }
}

module.exports = new SubscriptionService();
