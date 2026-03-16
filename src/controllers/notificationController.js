const prisma = require('../lib/prisma');
const pushNotificationService = require('../services/pushNotificationService');

const isValidPushToken = (token) => {
    if (!token || typeof token !== 'string') return false;
    return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
};

// GET /api/notifications — list notifications for current user
const getNotifications = async (req, res) => {
    try {
        const notifications = await prisma.notification.findMany({
            where: { userId: req.userId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        res.json({ success: true, data: { notifications } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications', message: error.message });
    }
};

// POST /api/notifications/register-token — save push token
const registerToken = async (req, res) => {
    try {
        const { pushToken } = req.body;
        if (!pushToken) return res.status(400).json({ error: 'pushToken is required' });
        if (!isValidPushToken(pushToken)) {
            return res.status(400).json({ error: 'Invalid Expo push token format' });
        }

        await prisma.user.update({
            where: { id: req.userId },
            data: { pushToken },
        });
        res.json({ success: true, message: 'Push token registered' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to register token', message: error.message });
    }
};

// POST /api/notifications/test-push — send a real push to current user
const testPush = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { pushToken: true },
        });

        if (!user?.pushToken) {
            return res.status(400).json({
                error: 'No push token registered for this account. Re-login and allow notifications first.',
            });
        }

        await createNotification(req.userId, {
            type: 'system',
            icon: 'notifications',
            color: '#6D28D9',
            title: 'Test Push Delivered',
            body: 'Your APK push notifications are working on this device.',
        });

        return res.json({ success: true, message: 'Test push sent' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to send test push', message: error.message });
    }
};

// PATCH /api/notifications/:id/read — mark one as read
const markRead = async (req, res) => {
    try {
        const result = await prisma.notification.updateMany({
            where: { id: req.params.id, userId: req.userId },
            data: { read: true },
        });

        if (result.count === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark read', message: error.message });
    }
};

// DELETE /api/notifications/:id — dismiss one notification
const dismissNotification = async (req, res) => {
    try {
        await prisma.notification.deleteMany({
            where: { id: req.params.id, userId: req.userId },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to dismiss', message: error.message });
    }
};

// DELETE /api/notifications — clear ALL notifications for user
const clearAll = async (req, res) => {
    try {
        await prisma.notification.deleteMany({ where: { userId: req.userId } });
        res.json({ success: true, message: 'All notifications cleared' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear notifications', message: error.message });
    }
};

// Internal helper — create a notification + optionally push to device
const createNotification = async (userId, { type, icon, color, title, body }) => {
    const notif = await prisma.notification.create({
        data: { userId, type, icon, color, title, body },
    });
    // Send push if user has a token
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pushToken: true } });
    if (user?.pushToken) {
        await pushNotificationService.sendPushNotification(
            user.pushToken,
            title,
            body,
            { type: type || 'notification', notificationId: notif.id }
        );
    }
    return notif;
};

module.exports = {
    getNotifications,
    registerToken,
    testPush,
    markRead,
    dismissNotification,
    clearAll,
    createNotification,
};
