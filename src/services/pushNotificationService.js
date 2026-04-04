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
 * Ensures a color is a valid 6-digit hex string with # prefix.
 */
const sanitizeHexColor = (color) => {
    if (!color || typeof color !== 'string') return '#6D28D9'; // Default Clora Purple
    let hex = color.startsWith('#') ? color : `#${color}`;
    // Simple regex for #RRGGBB or #AARRGGBB
    if (/^#([0-9A-F]{3}){1,2}$/i.test(hex) || /^#([0-9A-F]{4}){1,2}$/i.test(hex)) {
        return hex;
    }
    return '#6D28D9';
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

        const message = {
            to: pushToken,
            sound: 'default',
            priority: 'high', // Ensure visibility on lock screen
            channelId: 'default', // Android channel
            title,
            body,
            data,
            ...options,
        };

        // Strict validation: color must be a valid hex for Android push!
        if (message.color) {
            message.color = sanitizeHexColor(message.color);
        }

        messages.push(message);
    }

    if (messages.length === 0) return { sent: 0, failed: 0 };

    // Group messages by experienceId to avoid Expo error:
    // "All push notification messages in the same request must have the same experienceId"
    const messagesByExperience = {};
    for (const msg of messages) {
        let expId = 'default';
        const match = msg.to.match(/^ExponentPushToken\[([^/]+)\/.*\]$/);
        if (match) expId = match[1];
        
        if (!messagesByExperience[expId]) messagesByExperience[expId] = [];
        messagesByExperience[expId].push(msg);
    }

    let sent = 0;
    let failed = 0;
    const invalidTokens = new Set();

    for (const expId in messagesByExperience) {
        const expMessages = messagesByExperience[expId];
        const chunks = expo.chunkPushNotifications(expMessages);

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
                logger.error('PUSH', `Failed to send push notification chunk for ${expId}`, { error: err.message });
            }
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
 * Helper to both Save to DB and Send Push
 */
const createAndSendNotification = async (userId, { type, title, body, data = {}, options = {} }) => {
    try {
        // 1. Create DB record first (so it's in history even if push fails)
        const notification = await prisma.notification.create({
            data: {
                userId,
                type: type || 'system',
                title,
                body,
                icon: options.icon || 'notifications',
                color: options.color || '#6D28D9',
                read: false,
            }
        });

        // 2. Fetch User's Push Token
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { pushToken: true }
        });

        // 3. Send Push if token exists
        if (user?.pushToken) {
            await sendPushNotification(user.pushToken, title, body, { ...data, notificationId: notification.id }, options);
        }

        return notification;
    } catch (err) {
        logger.error('PUSH', 'Failed to create and send notification', { userId, title, error: err.message });
        throw err;
    }
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
const notifyAnalyticsMilestone = async (userId, milestone, value) => {
    return createAndSendNotification(userId, {
        type: 'growth',
        title: '🎯 Milestone Reached!',
        body: `You've hit ${value.toLocaleString()} ${milestone}! Keep growing with CloraAI.`,
        data: { milestone, value }
    });
};

/**
 * Convenience: Automation Win (Keyword Match)
 */
const notifyAutomationWin = async (userId, username, keyword) => {
    return createAndSendNotification(userId, {
        type: 'automation',
        title: '🚀 New Link Sent!',
        body: `@${username} commented '${keyword}' on your reel. Bot replied and DM'd the product.`,
        data: { username, keyword }
    });
};

/**
 * Convenience: Follow-Gate Block
 */
const notifyFollowGateBlock = async (userId, username) => {
    return createAndSendNotification(userId, {
        type: 'automation',
        title: '🔒 Almost there!',
        body: `@${username} commented but doesn't follow you. Bot asked them to follow first.`,
        data: { username }
    });
};

/**
 * Convenience: Critical Token Expiry
 */
const notifyTokenExpired = async (userId) => {
    return createAndSendNotification(userId, {
        type: 'account',
        title: '⚠️ IMMEDIATE ACTION REQUIRED',
        body: 'Your Instagram connection has expired. All automations are PAUSED. Tap to reconnect now.',
        data: { type: 'TOKEN_EXPIRED' },
        options: { priority: 'high' }
    });
};

/**
 * Convenience: Rate Limit / Automation Stopped
 */
const notifyAutomationStopped = async (userId, username, reason = 'daily DM limit') => {
    return createAndSendNotification(userId, {
        type: 'account',
        title: '🛑 Automation Error',
        body: `We couldn't reply to @${username} because your ${reason} was reached.`,
        data: { username, reason }
    });
};

/**
 * Convenience: Viral Alert
 */
const notifyViralAlert = async (userId, mediaTitle, views) => {
    return createAndSendNotification(userId, {
        type: 'growth',
        title: '🔥 Viral Alert!',
        body: `Your Reel "${mediaTitle}" is taking off with ${views.toLocaleString()} views! Ensure your automations are active.`,
        data: { mediaTitle, views }
    });
};

/**
 * Convenience: Referral Success
 */
const notifyReferralSuccess = async (userId, referredUsername) => {
    return createAndSendNotification(userId, {
        type: 'billing',
        title: '💰 Referral Reward!',
        body: `@${referredUsername} just signed up using your link. You've earned a reward!`,
        data: { referredUsername }
    });
};

/**
 * Convenience: Automation Active (Set-up confirmation)
 */
const sendAutomationActiveNotification = async (userId, platform, keyword) => {
    const platformName = platform === 'youtube' ? 'YouTube' : 'Instagram';
    const postType = platform === 'youtube' ? 'video' : 'post';
    const emoji = platform === 'youtube' ? '📺' : '✅';

    return createAndSendNotification(userId, {
        type: 'automation',
        title: `${emoji} Automation Active!`,
        body: `CloraAI is now monitoring your ${platformName} ${postType} for '${keyword}'.`,
        data: { platform, keyword }
    });
};

/**
 * Convenience: YouTube Automation Win
 */
const notifyYouTubeWin = async (userId, username) => {
    return createAndSendNotification(userId, {
        type: 'automation',
        title: '📺 YouTube Reply Sent!',
        body: `Bot replied to @${username}'s comment on your video.`,
        data: { username }
    });
};

/**
 * Convenience: Subscription Success
 */
const notifySubscriptionSuccess = async (userId, planName) => {
    return createAndSendNotification(userId, {
        type: 'billing',
        title: '⚡ PRO Activated!',
        body: `Your ${planName} subscription is now active. Enjoy unlimited automations!`,
        data: { planName }
    });
};

/**
 * Convenience: Credits Added
 */
const notifyCreditsAdded = async (userId, amount) => {
    return createAndSendNotification(userId, {
        type: 'billing',
        title: '💰 Credits Added!',
        body: `${amount} credits have been added to your account.`,
        data: { amount }
    });
};

/**
 * Convenience: AI Limit Hit
 */
const notifyAILimitHit = async (userId, feature) => {
    return createAndSendNotification(userId, {
        type: 'account',
        title: '🛑 AI Limit Reached',
        body: `You've reached your daily AI limit for ${feature.replace(/_/g, ' ')}. Upgrade to PRO for unlimited usage!`,
        data: { type: 'AI_LIMIT', feature },
        options: { priority: 'high' }
    });
};

module.exports = {
    sendPushNotification,
    isLikelyExpoToken,
    notifyPostSuccess,
    notifyPostFailure,
    notifySubscriptionRenewal,
    notifyAnalyticsMilestone,
    notifyAutomationWin,
    notifyFollowGateBlock,
    notifyTokenExpired,
    notifyAutomationStopped,
    notifyViralAlert,
    notifyReferralSuccess,
    notifyYouTubeWin,
    notifySubscriptionSuccess,
    notifyCreditsAdded,
    notifyAILimitHit,
    sendAutomationActiveNotification,
    notifyAutomationDeleted: async (userId, platform, keyword) => {
        return createAndSendNotification(userId, {
            type: 'automation',
            title: '🗑️ Automation Removed',
            body: `Your ${platform} automation for '${keyword}' was deleted.`,
            options: { icon: 'trash-outline', color: '#EF4444' }
        });
    },
    notifyLinkSuccess: async (userId, platform) => {
        const isYT = platform === 'youtube';
        return createAndSendNotification(userId, {
            type: 'account',
            title: `🔗 ${isYT ? 'YouTube' : 'Instagram'} Connected`,
            body: `Successfully linked your ${isYT ? 'YouTube channel' : 'Instagram account'} to CloraAI!`,
            options: { 
                icon: isYT ? 'logo-youtube' : 'logo-instagram', 
                color: isYT ? '#FF0000' : '#E1306C' 
            }
        });
    },
    notifyAccountAction: async (userId, title, body) => {
        return createAndSendNotification(userId, {
            type: 'account',
            title,
            body,
            options: { icon: 'person-circle-outline', color: '#6366F1' }
        });
    }
};
