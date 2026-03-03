const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Send real Expo push notification
const sendExpoPush = async (pushToken, title, body) => {
    if (!pushToken || !pushToken.startsWith('ExponentPushToken')) return;
    try {
        await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                to: pushToken,
                sound: 'default',
                title,
                body,
                data: { type: 'notification' },
            }),
        });
    } catch (e) {
        console.warn('Push send error:', e.message);
    }
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

        await prisma.user.update({
            where: { id: req.userId },
            data: { pushToken },
        });
        res.json({ success: true, message: 'Push token registered' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to register token', message: error.message });
    }
};

// PATCH /api/notifications/:id/read — mark one as read
const markRead = async (req, res) => {
    try {
        await prisma.notification.update({
            where: { id: req.params.id, userId: req.userId },
            data: { read: true },
        });
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
        await sendExpoPush(user.pushToken, title, body);
    }
    return notif;
};

module.exports = {
    getNotifications,
    registerToken,
    markRead,
    dismissNotification,
    clearAll,
    createNotification,
};
