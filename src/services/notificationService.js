/**
 * src/services/NotificationService.js
 * SaaS Engagement & Alert Layer
 */

const prisma = require('../lib/prisma');
const pushNotificationService = require('../services/pushNotificationService');
const logger = require('../utils/logger');

class NotificationService {
    /**
     * Internal: Manage Device Tokens (Multi-device Support)
     */
    async registerDevice(userId, { token, os, deviceName }) {
        try {
            // In Prisma schema, 'token' is unique. Upsert by token.
            await prisma.deviceToken.upsert({
                where: { token },
                create: { userId, token, os, deviceName },
                update: { userId, os, deviceName, lastUsed: new Date() }
            });
            
            // Also update the primary pushToken for legacy compatibility
            await prisma.user.update({
                where: { id: userId },
                data: { pushToken: token }
            });
            
            logger.info('NOTIFICATION_REG', `Token ${token} matched to user ${userId}`);
        } catch (err) {
            logger.error('NOTIFICATION_REG_FAIL', err.message);
            throw err;
        }
    }

    async removeDevice(userId, token) {
        return prisma.deviceToken.deleteMany({ where: { userId, token } });
    }

    async getUserDevices(userId) {
        return prisma.deviceToken.findMany({ where: { userId } });
    }

    /**
     * Send Push to specific user devices
     */
    async sendToUser(userId, { title, body, data = {}, priority = 'high' }) {
        const devices = await this.getUserDevices(userId);
        const tokens = devices.map(d => d.fcmToken).filter(Boolean);
        
        if (tokens.length === 0) return { count: 0 };

        try {
            // Internal call to actual push provider
            await pushNotificationService.sendPushNotification(tokens, title, body, data);
            return { count: tokens.length };
        } catch (err) {
            logger.warn('PUSH_SEND_FAIL', `User ${userId} push failed: ${err.message}`);
            return { count: 0 };
        }
    }

    /**
     * Internal: Basic Push Sender
     */
    async sendPush(userId, title, body, data = {}) {
        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { pushToken: true }
            });
            if (user?.pushToken) {
                await pushNotificationService.sendPushNotification([user.pushToken], title, body, data);
            }
        } catch (err) {
            logger.warn('NOTIFICATION_PUSH_FAIL', `User ${userId} push failed: ${err.message}`);
        }
    }

    /**
     * Internal: Basic DB Notification Creator
     */
    async sendDB(userId, title, body, type = 'system', color = '#7C3AED') {
        try {
            await prisma.notification.create({
                data: { userId, title, body, type, color }
            });
        } catch (err) {
            logger.warn('NOTIFICATION_DB_FAIL', `User ${userId} DB notify failed: ${err.message}`);
        }
    }

    /**
     * Event: Payment Captured
     */
    async notifyPaymentSuccess(userId, amount) {
        const title = 'Payment Received! 💳';
        const body = `Thank you! Your payment of ₹${amount} was successful. Your Pro access is now active.`;
        await Promise.all([
            this.sendDB(userId, title, body, 'payment', '#10B981'),
            this.sendPush(userId, title, body, { type: 'payment_success' })
        ]);
    }

    /**
     * Event: Payment Failed / Initial Attempt
     */
    async notifyPaymentFailed(userId, planName) {
        const title = 'Payment Failed ⚠';
        const body = `We couldn't process your payment for the ${planName} plan. Please update your payment method.`;
        await Promise.all([
            this.sendDB(userId, title, body, 'payment_error', '#EF4444'),
            this.sendPush(userId, title, body, { type: 'payment_failed' })
        ]);
    }

    /**
     * Event: Subscription Expiring Soon
     */
    async notifyExpiringSoon(userId, days) {
        const title = 'Your Pro Plan is Expiring! ⏳';
        const body = `Your CloraAI Pro subscription will expire in ${days} days. Keep your automations alive - renew now!`;
        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#F59E0B'),
            this.sendPush(userId, title, body, { type: 'expiry_alert', days })
        ]);
    }

    /**
     * Event: Subscription Halted (Permanent Failure)
     */
    async notifyHalted(userId) {
        const title = 'Automations Paused 🛑';
        const body = `Your subscription has been halted due to multiple payment failures. Your automations are now inactive.`;
        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#EF4444'),
            this.sendPush(userId, title, body, { type: 'subscription_halted' })
        ]);
    }
}

module.exports = new NotificationService();
