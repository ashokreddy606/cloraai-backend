const prisma = require('../lib/prisma');
const logger = require('../utils/logger');

/**
 * Register/Update Push Token for User
 */
exports.registerToken = async (req, res) => {
  try {
    const userId = req.userId;
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { pushToken }
    });

    logger.info('NOTIFICATION', `Push token registered for user ${userId}`);
    res.status(200).json({ success: true, message: 'Push token updated' });
  } catch (error) {
    logger.error('NOTIFICATION', 'Register token error:', error);
    res.status(500).json({ error: 'Failed to register token' });
  }
};

/**
 * Get User Notifications
 */
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.userId;
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.status(200).json({
      success: true,
      data: { notifications }
    });
  } catch (error) {
    logger.error('NOTIFICATION', 'Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
};

/**
 * Mark All Notifications as Read
 */
exports.markAllRead = async (req, res) => {
  try {
    const userId = req.userId;

    await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('NOTIFICATION', 'Mark all read error:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
};

/**
 * Mark Single Notification as Read
 */
exports.markAsRead = async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.userId;
  
      await prisma.notification.updateMany({
        where: { id, userId },
        data: { read: true }
      });
  
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error('NOTIFICATION', 'Mark read error:', error);
      res.status(500).json({ error: 'Failed to update notification' });
    }
};
