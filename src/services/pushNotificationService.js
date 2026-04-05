/**
 * Legacy Push Notification Service Bridge
 * Redirects all legacy Expo calls to the new production-grade FCM notificationService.
 */
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

module.exports = {
    // Core Bridge: Redirects to FCM sendToUser or direct batch delivery
    sendPushNotification: async (pushTokens, title, body, data = {}) => {
        logger.info('PUSH_BRIDGE', `Redirecting legacy multicast to FCM for ${pushTokens.length} tokens`);
        
        // Construct a standard v1 payload for the bridge
        const payload = {
            notification: { title, body },
            data: { ...data, title, body },
            android: {
                priority: 'high',
                notification: { sound: 'default', channelId: 'default' }
            },
            apns: {
                payload: {
                    aps: { alert: { title, body }, sound: 'default', mutableContent: true }
                }
            }
        };

        return notificationService.processBatchDelivery({
            tokens: pushTokens,
            payload,
            userId: 'BROADCAST_SYSTEM'
        });
    },

    isLikelyExpoToken: (token) => {
        if (!token || typeof token !== 'string') return false;
        return token.includes('ExponentPushToken') || token.includes('ExpoPushToken');
    },

    // Convenience Method Mappings
    notifyAutomationWin: (userId, username, keyword) => 
        notificationService.notifyAutomationWin(userId, username, keyword),

    notifyFollowGateBlock: (userId, username) => 
        notificationService.notifyFollowGateBlock(userId, username),

    notifyTokenExpired: (userId) => 
        notificationService.notifyTokenExpired(userId),

    notifySubscriptionSuccess: (userId, planName) => 
        notificationService.notifySubscriptionSuccess(userId, planName),

    notifyCreditsAdded: (userId, amount) => 
        notificationService.notifyCreditsAdded(userId, amount),

    notifyAILimitHit: (userId, feature) => 
        notificationService.notifyAILimitHit(userId, feature),

    sendAutomationActiveNotification: (userId, platform, keyword) => 
        notificationService.sendAutomationActiveNotification(userId, platform, keyword),

    notifyAccountAction: (userId, title, body) => 
        notificationService.notifyAccountAction(userId, title, body),

    notifyYouTubeWin: (userId, authorName) => 
        notificationService.notifyYouTubeWin(userId, authorName),

    notifyAnalyticsMilestone: (userId, metric, value) => 
        notificationService.notifyAnalyticsMilestone(userId, metric, value),

    notifyViralAlert: (userId, contentName, reach) => 
        notificationService.notifyViralAlert(userId, contentName, reach),

    // Additional mappings for un-implemented but used methods
    notifyPostSuccess: (pushToken, postTitle) => {
        logger.warn('PUSH_BRIDGE', 'notifyPostSuccess called with token. FCM requires userId. Skipping.');
    },
    notifyPostFailure: (pushToken, postTitle, reason) => {
        logger.warn('PUSH_BRIDGE', 'notifyPostFailure called with token. FCM requires userId. Skipping.');
    },
    notifySubscriptionRenewal: (pushToken, daysLeft) => {
        logger.warn('PUSH_BRIDGE', 'notifySubscriptionRenewal called with token. FCM requires userId. Skipping.');
    },

    // New Mappings
    notifyAutomationDeleted: (userId, platform, keyword) => 
        notificationService.notifyAutomationDeleted(userId, platform, keyword),

    notifyLinkSuccess: (userId, platform) => 
        notificationService.notifyLinkSuccess(userId, platform)
};
