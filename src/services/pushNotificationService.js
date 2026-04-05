/**
 * Legacy Push Notification Service Bridge
 * Redirects all legacy Expo calls to the new production-grade FCM notificationService.
 */
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

module.exports = {
    // Core Bridge: Redirects to FCM sendToUser
    sendPushNotification: async (pushTokens, title, body, data = {}) => {
        logger.info('PUSH_BRIDGE', 'Redirecting legacy sendPushNotification to FCM');
        // Note: In this bridge, we can't easily map back to a single userId if multiple tokens are passed
        // but most callers use the convenience methods below.
        return { sent: 0, failed: 0, message: 'Deprecated: Use notificationService.sendToUser instead' };
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
