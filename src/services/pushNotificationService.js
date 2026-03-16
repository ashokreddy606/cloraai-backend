/**
 * Backend Push Notification Service
 * Uses expo-server-sdk to send push notifications to mobile devices.
 * 
 * Install: npm install expo-server-sdk
 */
const { Expo } = require('expo-server-sdk');
const logger = require('../utils/logger');
const prisma = require('../lib/prisma');

const expo = new Expo();

const isLikelyExpoToken = (token) => {
    if (!token || typeof token !== 'string') return false;
    return (
        Expo.isExpoPushToken(token) ||
        /^ExponentPushToken\[[^\]]+\]$/.test(token) ||
        /^ExpoPushToken\[[^\]]+\]$/.test(token)
    );
};

const removeInvalidPushTokens = async (tokens) => {
    if (!tokens.length) return;

    await Promise.allSettled(
        tokens.map((token) => prisma.user.updateMany({
            where: { pushToken: token },
            data: { pushToken: null },
        }))
    );
};

/**
 * Send a push notification to one or more Expo push tokens.
 * 
 * @param {string|string[]} pushTokens - Expo push token(s) to send to
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {object} data - Additional payload (accessible in app)
 * @param {object} options - Additional Expo notification options
 */
const sendPushNotification = async (pushTokens, title, body, data = {}, options = {}) => {
    const tokens = Array.isArray(pushTokens) ? pushTokens : [pushTokens];
    const uniqueTokens = [...new Set(tokens.filter(Boolean))];

    // Build messages for valid Expo push tokens
    const messages = [];
    for (const pushToken of uniqueTokens) {
        if (!isLikelyExpoToken(pushToken)) {
            logger.warn('PUSH', `Invalid Expo push token: ${pushToken}`);
            continue;
        }
        messages.push({
            to: pushToken,
            sound: 'default',
            title,
            body,
            data,
            ...options,
        });
    }

    if (messages.length === 0) return { sent: 0, failed: 0 };

    // Expo recommends chunking into batches of 100
    const chunks = expo.chunkPushNotifications(messages);
    let sent = 0;
    let failed = 0;
    const invalidTokens = new Set();

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            for (let i = 0; i < ticketChunk.length; i++) {
                const ticket = ticketChunk[i];
                const token = chunk[i]?.to;

                if (ticket.status === 'ok') {
                    sent++;
                } else {
                    failed++;
                    logger.warn('PUSH', `Push ticket error: ${ticket.message}`, { details: ticket.details });

                    if (ticket?.details?.error === 'DeviceNotRegistered' && token) {
                        invalidTokens.add(token);
                    }
                }
            }
        } catch (err) {
            failed += chunk.length;
            logger.error('PUSH', 'Failed to send push notification chunk', { error: err.message });
        }
    }

    if (invalidTokens.size > 0) {
        await removeInvalidPushTokens([...invalidTokens]);
        logger.info('PUSH', `Cleared ${invalidTokens.size} invalid push token(s) from DB`);
    }

    logger.info('PUSH', `Notifications sent: ${sent}, failed: ${failed}`);
    return { sent, failed };
};

/**
 * Convenience: notify user of scheduled post success
 */
const notifyPostSuccess = async (pushToken, postTitle) => {
    return sendPushNotification(
        pushToken,
        '✅ Post Published!',
        `Your scheduled post "${postTitle}" was published successfully.`,
        { type: 'POST_SUCCESS' }
    );
};

/**
 * Convenience: notify user of scheduled post failure
 */
const notifyPostFailure = async (pushToken, postTitle, reason) => {
    return sendPushNotification(
        pushToken,
        '❌ Post Failed',
        `Your scheduled post "${postTitle}" failed to publish. Tap to retry.`,
        { type: 'POST_FAILURE', reason }
    );
};

/**
 * Convenience: subscription renewal reminder
 */
const notifySubscriptionRenewal = async (pushToken, daysLeft) => {
    return sendPushNotification(
        pushToken,
        '⚡ Pro Subscription Expiring',
        `Your CloraAI Pro plan expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew now to keep your features.`,
        { type: 'SUBSCRIPTION_RENEWAL', daysLeft }
    );
};

/**
 * Convenience: analytics milestone
 */
const notifyAnalyticsMilestone = async (pushToken, milestone, value) => {
    return sendPushNotification(
        pushToken,
        '🎯 Milestone Reached!',
        `You've hit ${value.toLocaleString()} ${milestone}! Keep growing with CloraAI.`,
        { type: 'ANALYTICS_MILESTONE', milestone, value }
    );
};

module.exports = {
    sendPushNotification,
    notifyPostSuccess,
    notifyPostFailure,
    notifySubscriptionRenewal,
    notifyAnalyticsMilestone,
};
