const notificationService = require('../services/notificationService');
const Notification = require('../models/Notification');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

/**
 * Register/Update Device Token
 */
exports.registerDevice = async (req, res) => {
  try {
    const userId = req.userId; // From JWT
    const { token, fcmToken, os, platform, deviceName } = req.body;

    // Support both new (token, os) and old (fcmToken, platform) keys for reliability
    const finalToken = token || fcmToken;
    const finalOs = os || platform;

    await notificationService.registerDevice(userId, { 
      token: finalToken, 
      os: finalOs, 
      deviceName 
    });

    res.status(200).json({
      success: true,
      message: 'Device registered successfully'
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Register device error:', { error: error.message });
    res.status(500).json({ error: 'Failed to register device' });
  }
};

/**
 * Remove Device Token (Logout)
 */
exports.removeDevice = async (req, res) => {
  try {
    const userId = req.userId;
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    await notificationService.removeDevice(userId, deviceId);

    res.status(200).json({
      success: true,
      message: 'Device removed successfully'
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Remove device error:', { error: error.message });
    res.status(500).json({ error: 'Failed to remove device' });
  }
};

/**
 * List User Devices
 */
exports.getDevices = async (req, res) => {
  try {
    const userId = req.userId;
    const devices = await notificationService.getUserDevices(userId);

    res.status(200).json({
      success: true,
      data: { devices }
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Get devices error:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

/**
 * Get User Notification History
 */
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const query = { userId: new mongoose.Types.ObjectId(userId) };
    
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Notification.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        notifications,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Get notifications error:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
};

/**
 * Mark Notification as Read
 */
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: new mongoose.Types.ObjectId(userId) },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Mark as read error:', { error: error.message });
    res.status(500).json({ error: 'Failed to update notification' });
  }
};

/**
 * Mark All Notifications as Read
 */
exports.markAllRead = async (req, res) => {
  try {
    const userId = req.userId;

    await Notification.updateMany(
      { userId: new mongoose.Types.ObjectId(userId), read: false },
      { read: true }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Mark all read error:', { error: error.message });
    res.status(500).json({ error: 'Failed to update notifications' });
  }
};

/**
 * Send Test Notification (Admin/Internal)
 */
exports.sendTestNotification = async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title, and body are required' });
    }

    const notification = await notificationService.sendToUser(userId, {
      title,
      body,
      data: data || {},
      priority: 'high'
    });

    res.status(200).json({
      success: true,
      message: 'Test notification queued',
      data: { notificationId: notification._id }
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Send test notification error:', { error: error.message });
    res.status(500).json({ error: 'Failed to queue test notification' });
  }
};

/**
 * Get Notification System Health (Admin Only)
 */
exports.getHealth = async (req, res) => {
  try {
    const { notificationQueue } = require('../utils/queue');
    
    if (!notificationQueue) {
      return res.status(503).json({
        success: false,
        status: 'Unhealthy',
        message: 'Notification queue not initialized (Redis connection issue)'
      });
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      notificationQueue.getWaitingCount(),
      notificationQueue.getActiveCount(),
      notificationQueue.getCompletedCount(),
      notificationQueue.getFailedCount(),
      notificationQueue.getDelayedCount()
    ]);

    res.status(200).json({
      success: true,
      data: {
        status: 'Healthy',
        counts: {
          waiting,
          active,
          completed,
          failed,
          delayed
        },
        workerConcurrency: 10,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Health check error:', { error: error.message });
    res.status(500).json({ error: 'Failed to perform health check' });
  }
};

/**
 * Bulk Delete Notifications
 */
exports.bulkDelete = async (req, res) => {
  try {
    const userId = req.userId;
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    // Convert string IDs to ObjectIds for Mongoose
    const objectIds = ids.map(id => new mongoose.Types.ObjectId(id));

    const result = await Notification.deleteMany({
      _id: { $in: objectIds },
      userId: new mongoose.Types.ObjectId(userId)
    });

    res.status(200).json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} notifications`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Bulk delete error:', { error: error.message });
    res.status(500).json({ error: 'Failed to perform bulk delete' });
  }
};

/**
 * Delete All Notifications (Clear All)
 */
exports.deleteAll = async (req, res) => {
  try {
    const userId = req.userId;

    const result = await Notification.deleteMany({
      userId: new mongoose.Types.ObjectId(userId)
    });

    res.status(200).json({
      success: true,
      message: `Successfully cleared ${result.deletedCount} notifications`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Clear all error:', { error: error.message });
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
};

/**
 * Delete Single Notification
 */
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const result = await Notification.deleteOne({
      _id: id,
      userId: new mongoose.Types.ObjectId(userId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    logger.error('NOTIFICATION_CONTROLLER', 'Delete notification error:', { error: error.message });
    res.status(500).json({ error: 'Failed to delete notification' });
  }
};
