/**
 * src/services/NotificationService.js
 * SaaS Engagement & Alert Layer
 */

const prisma = require('../lib/prisma');
const pushNotificationService = require('../services/pushNotificationService');
const { admin } = require('../lib/firebase');
const { Expo } = require('expo-server-sdk');
const { notificationQueue, enqueueJob } = require('../utils/queue');
const logger = require('../utils/logger');

const expo = new Expo();

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
        const tokens = devices.map(d => d.token).filter(Boolean);
        
        if (tokens.length === 0) return { count: 0 };

        try {
            // Production Flow: Enqueue to BullMQ for background delivery
            await this.enqueuePush(userId, { title, body, data, priority });
            return { success: true, userId };
        } catch (err) {
            logger.warn('PUSH_ENQUEUE_FAIL', `User ${userId} push queue failed: ${err.message}`);
            return { count: 0 };
        }
    }

    /**
     * Production: Enqueue Push Notification to BullMQ
     */
    async enqueuePush(userId, { title, body, data = {}, priority = 'high', imageUrl = null }) {
        try {
            const devices = await this.getUserDevices(userId);
            const tokens = devices.map(d => d.token).filter(Boolean);
            
            if (tokens.length === 0) return false;

            // Normalize payload for FCM v1
            const payload = {
                notification: { 
                    title, 
                    body,
                    ...(imageUrl && { imageUrl }) 
                },
                data: { 
                    ...data, 
                    title, 
                    body,
                    click_action: 'FLUTTER_NOTIFICATION_CLICK' // Standard for Android deep linking
                },
                android: {
                    priority,
                    notification: { 
                        sound: 'default', 
                        channelId: data.channelId || 'default',
                        ...(imageUrl && { image: imageUrl })
                    }
                },
                apns: {
                    payload: {
                        aps: { 
                            alert: { title, body }, 
                            sound: 'default', 
                            mutableContent: true 
                        }
                    },
                    fcm_options: {
                        ...(imageUrl && { image: imageUrl })
                    }
                }
            };

            await enqueueJob(notificationQueue, 'send-notification', {
                userId,
                tokens,
                payload
            });

            return true;
        } catch (err) {
            logger.error('NOTIFICATION_ENQUEUE_ERR', err.message);
            return false;
        }
    }

    /**
     * Worker: Process Batch Delivery for BullMQ
     */
    async processBatchDelivery({ tokens, payload, userId }) {
        if (!tokens || tokens.length === 0) return { successCount: 0, failureCount: 0 };

        const expoTokens = [];
        const fcmTokens = [];

        // 1. Categorize tokens (FCM vs Expo)
        tokens.forEach(token => {
            if (Expo.isExpoPushToken(token)) {
                expoTokens.push(token);
            } else {
                fcmTokens.push(token);
            }
        });

        const results = { successCount: 0, failureCount: 0 };

        // 2. Deliver via Expo Push SDK
        if (expoTokens.length > 0) {
            try {
                const messages = expoTokens.map(token => ({
                    to: token,
                    sound: 'default',
                    title: payload.notification.title,
                    body: payload.notification.body,
                    data: payload.data,
                    priority: 'high'
                }));

                const chunks = expo.chunkPushNotifications(messages);
                const tickets = [];

                for (const chunk of chunks) {
                    try {
                        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                        tickets.push(...ticketChunk);
                    } catch (error) {
                        logger.error('EXPO_PUSH_CHUNK_FAIL', error.message);
                    }
                }

                // Handle invalid Expo tokens
                const invalidExpoTokens = [];
                tickets.forEach((ticket, idx) => {
                    if (ticket.status === 'ok') {
                        results.successCount++;
                    } else if (ticket.status === 'error') {
                        results.failureCount++;
                        if (ticket.details?.error === 'DeviceNotRegistered') {
                            invalidExpoTokens.push(expoTokens[idx]);
                        }
                    }
                });

                if (invalidExpoTokens.length > 0) {
                    await prisma.deviceToken.deleteMany({
                        where: { token: { in: invalidExpoTokens } }
                    });
                    logger.info('NOTIFICATION_CLEANUP', `Purged ${invalidExpoTokens.length} dead Expo tokens for user ${userId}`);
                }
            } catch (err) {
                logger.error('EXPO_BATCH_FAIL', err.message);
            }
        }

        // 3. Deliver via Firebase Admin SDK
        if (fcmTokens.length > 0) {
            try {
                const responses = await admin.messaging().sendEachForMulticast({
                    tokens: fcmTokens,
                    notification: payload.notification,
                    data: payload.data,
                    android: payload.android,
                    apns: payload.apns
                });

                results.successCount += responses.successCount;
                results.failureCount += responses.failureCount;

                // Handle invalid FCM tokens
                const invalidFcmTokens = [];
                responses.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const error = resp.error?.code || '';
                        if (error === 'messaging/invalid-registration-token' || error === 'messaging/registration-token-not-registered') {
                            invalidFcmTokens.push(fcmTokens[idx]);
                        }
                    }
                });

                if (invalidFcmTokens.length > 0) {
                    await prisma.deviceToken.deleteMany({
                        where: { token: { in: invalidFcmTokens } }
                    });
                    logger.info('NOTIFICATION_CLEANUP', `Purged ${invalidFcmTokens.length} dead FCM tokens for user ${userId}`);
                }
            } catch (err) {
                logger.error('FCM_BATCH_FAIL', err.message);
                // If it's a critical FCM error (like missing cert), we only retry if no tokens were sent at all
                if (results.successCount === 0) throw err;
            }
        }

        return results;
    }

    /**
     * Legacy Wrapper (Redirects to enqueue)
     */
    async sendPush(userId, title, body, data = {}) {
        return this.enqueuePush(userId, { title, body, data });
    }

    /**
     * Internal: Basic DB Notification Creator
     */
    async sendDB(userId, title, body, type = 'system', color = '#7C3AED', metadata = null) {
        try {
            await prisma.notification.create({
                data: { 
                    userId, 
                    title, 
                    body, 
                    type, 
                    color,
                    metadata: metadata ? JSON.stringify(metadata) : null 
                }
            });
        } catch (err) {
            logger.warn('NOTIFICATION_DB_FAIL', `User ${userId} DB notify failed: ${err.message}`);
        }
    }

    /**
     * Event: Automation "Win" (Success Reply)
     */
    async notifyAutomationWin(userId, username, keyword) {
        const title = 'Automation Success! ✅';
        const body = `Successfully replied to @${username} for keyword: "${keyword}".`;
        const data = { screen: 'DMAutomation', platform: 'instagram' };
        
        await Promise.all([
            this.sendDB(userId, title, body, 'automation', '#10B981', data),
            this.enqueuePush(userId, { 
                title, 
                body, 
                data, 
                imageUrl: 'https://clora.ai/assets/notif/ig-success.png' 
            })
        ]);
    }

    /**
     * Event: YouTube Automation Win
     */
    async notifyYouTubeWin(userId, authorName) {
        const title = 'YouTube Reply Sent! 📺';
        const body = `AI successfully replied to a comment by ${authorName}.`;
        const data = { screen: 'YoutubeAutomationRules', platform: 'youtube' };

        await Promise.all([
            this.sendDB(userId, title, body, 'automation', '#FF0000', data),
            this.enqueuePush(userId, { 
                title, 
                body, 
                data, 
                imageUrl: 'https://clora.ai/assets/notif/yt-success.png' 
            })
        ]);
    }

    /**
     * Event: Viral Alert (High Engagement)
     */
    async notifyViralAlert(userId, contentName, reach) {
        const title = 'Viral Alert! 🔥';
        const body = `Your content "${contentName}" is blowing up! Reach: ${reach}+. Check your analytics now.`;
        const data = { screen: 'Analytics' };

        await Promise.all([
            this.sendDB(userId, title, body, 'viral', '#F59E0B', data),
            this.enqueuePush(userId, { 
                title, 
                body, 
                data, 
                priority: 'high',
                imageUrl: 'https://clora.ai/assets/notif/viral.png' 
            })
        ]);
    }

    /**
     * Event: Token Expired (Critical)
     */
    async notifyTokenExpired(userId, platform = 'Instagram') {
        const title = `${platform} Disconnected! 🛑`;
        const body = `Your ${platform} session has expired. Re-link your account now to keep automations alive.`;
        const data = { screen: 'Settings' };

        await Promise.all([
            this.sendDB(userId, title, body, 'error', '#EF4444', data),
            this.enqueuePush(userId, { 
                title, 
                body, 
                data, 
                priority: 'high' 
            })
        ]);
    }

    /**
     * Event: AI Limit Hit
     */
    async notifyAILimitHit(userId, feature) {
        const title = 'AI Limit Reached 🤖';
        const body = `You've reached your free usage limit for ${feature}. Upgrade to Pro for unlimited AI power!`;
        const data = { screen: 'Upgrade' };

        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#6366F1', data),
            this.enqueuePush(userId, { title, body, data })
        ]);
    }

    /**
     * Event: Payment Captured
     */
    async notifyPaymentSuccess(userId, amount) {
        const title = 'Payment Received! 💳';
        const body = `Thank you! Your payment of ₹${amount} was successful. Pro access is now active.`;
        const data = { screen: 'TransactionHistory' };

        await Promise.all([
            this.sendDB(userId, title, body, 'payment', '#10B981', data),
            this.enqueuePush(userId, { 
                title, 
                body, 
                data, 
                imageUrl: 'https://clora.ai/assets/notif/success-sparkle.png' 
            })
        ]);
    }

    /**
     * Event: Payment Failed
     */
    async notifyPaymentFailed(userId, planName) {
        const title = 'Payment Failed ⚠';
        const body = `We couldn't process payment for ${planName}. Please check your payment method.`;
        const data = { screen: 'Upgrade' };

        await Promise.all([
            this.sendDB(userId, title, body, 'payment_error', '#EF4444', data),
            this.enqueuePush(userId, { title, body, data, priority: 'high' })
        ]);
    }

    /**
     * Event: Subscription Expiring Soon
     */
    async notifyExpiringSoon(userId, days) {
        const title = 'Pro Plan Expiring! ⏳';
        const body = `Your Pro subscription expires in ${days} days. Renew now to keep your rules active.`;
        const data = { screen: 'Upgrade' };

        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#F59E0B', data),
            this.enqueuePush(userId, { title, body, data, priority: 'high' })
        ]);
    }

    /**
     * Event: Account Action (Custom)
     */
    async notifyAccountAction(userId, title, body) {
        await Promise.all([
            this.sendDB(userId, title, body),
            this.enqueuePush(userId, { title, body })
        ]);
    }

    /**
     * Event: Automation Deleted
     */
    async notifyAutomationDeleted(userId, platform, keyword) {
        const title = 'Automation Removed 🗑';
        const body = `Successfully deleted ${platform} rule for "${keyword}".`;
        
        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#94A3B8'),
            this.enqueuePush(userId, { title, body })
        ]);
    }

    /**
     * Event: Automation Active
     */
    async sendAutomationActiveNotification(userId, platform, keyword) {
        const title = 'Automation Active! ⚡';
        const body = `Your ${platform} rule for "${keyword}" is now live and monitoring comments.`;
        const data = { screen: platform === 'instagram' ? 'DMAutomation' : 'YoutubeAutomationRules' };

        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#10B981', data),
            this.enqueuePush(userId, { title, body, data })
        ]);
    }

    /**
     * Event: Account Linked Successfully
     */
    async notifyLinkSuccess(userId, platform) {
        const title = 'Account Connected! 🔗';
        const body = `Your ${platform.charAt(0).toUpperCase() + platform.slice(1)} account was successfully linked to CloraAI.`;
        const data = { screen: 'Settings' };

        await Promise.all([
            this.sendDB(userId, title, body, 'system', '#10B981', data),
            this.enqueuePush(userId, { title, body, data })
        ]);
    }
}

module.exports = new NotificationService();
