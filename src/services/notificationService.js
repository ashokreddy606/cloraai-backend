const DeviceToken = require('../models/DeviceToken');
const Notification = require('../models/Notification');
const { notificationQueue, enqueueJob } = require('../utils/queue');
const { admin } = require('../lib/firebase');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

/**
 * Service to handle multi-device notifications
 */
class NotificationService {
  /**
   * Register or Update a device token for a user
   * @param {string} userId 
   * @param {Object} deviceInfo { deviceId, fcmToken, platform }
   */
  async registerDevice(userId, { deviceId, fcmToken, platform }) {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      
      const device = await DeviceToken.findOneAndUpdate(
        { userId: userObjectId, deviceId },
        { 
          fcmToken, 
          platform, 
          lastActive: new Date() 
        },
        { upsert: true, new: true }
      );

      logger.info('NOTIFICATION_SERVICE', `Device registered/updated for user ${userId}: ${deviceId}`);
      return device;
    } catch (error) {
      logger.error('NOTIFICATION_SERVICE', 'Error registering device:', { error: error.message });
      throw error;
    }
  }

  /**
   * Remove a device token
   * @param {string} userId 
   * @param {string} deviceId 
   */
  async removeDevice(userId, deviceId) {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      await DeviceToken.deleteOne({ userId: userObjectId, deviceId });
      logger.info('NOTIFICATION_SERVICE', `Device removed for user ${userId}: ${deviceId}`);
    } catch (error) {
      logger.error('NOTIFICATION_SERVICE', 'Error removing device:', { error: error.message });
      throw error;
    }
  }

  /**
   * Get all devices for a user
   * @param {string} userId 
   */
  async getUserDevices(userId) {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    return await DeviceToken.find({ userId: userObjectId }).sort({ lastActive: -1 });
  }

  /**
   * Trigger a notification for a user (sends to all active devices)
   * @param {string} userId 
   * @param {Object} payload { title, body, data, notificationId, priority }
   */
  async sendToUser(userId, { title, body, data = {}, notificationId = null, priority = 'normal' }) {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // 1. Store notification in history
      const notification = await Notification.create({
        userId: userObjectId,
        title,
        body,
        data,
        notificationId
      });

      // 2. Fetch all active device tokens
      const devices = await DeviceToken.find({ userId: userObjectId });
      
      if (devices.length === 0) {
        logger.warn('NOTIFICATION_SERVICE', `No active devices found for user ${userId}. Notification stored but not sent.`);
        return notification;
      }

      const tokens = devices.map(d => d.fcmToken);

      // 3. Enqueue for background processing
      await enqueueJob(notificationQueue, 'send-notification', {
        userId,
        notificationId: notification._id,
        tokens,
        payload: {
          notification: { title, body },
          data: {
            ...data,
            notificationId: notification._id.toString(),
            externalId: notificationId || ''
          },
          android: {
            priority: priority === 'high' ? 'high' : 'normal',
          },
          apns: {
            payload: {
              aps: {
                contentAvailable: true,
                badge: 1
              }
            }
          }
        }
      });

      return notification;
    } catch (error) {
      logger.error('NOTIFICATION_SERVICE', 'Error triggering notification:', { error: error.message });
      throw error;
    }
  }

  /**
   * Batch send notifications (used by worker)
   * Handles invalid/expired tokens automatically
   */
  async processBatchDelivery(jobData) {
    const { tokens, payload, userId } = jobData;
    
    if (!tokens || tokens.length === 0) return;

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload
      });

      const tokensToRemove = [];
      
      response.responses.forEach((res, idx) => {
        if (!res.success) {
          const error = res.error;
          // Check if token is invalid or unregistered
          if (error.code === 'messaging/registration-token-not-registered' || 
              error.code === 'messaging/invalid-registration-token') {
            tokensToRemove.push(tokens[idx]);
          }
          logger.warn('NOTIFICATION_SERVICE', `FCM Delivery failed: ${error.code}`, { token: tokens[idx] });
        }
      });

      // Auto-delete invalid tokens
      if (tokensToRemove.length > 0) {
        await DeviceToken.deleteMany({ fcmToken: { $in: tokensToRemove } });
        logger.info('NOTIFICATION_SERVICE', `Cleaned up ${tokensToRemove.length} invalid tokens for user ${userId}`);
      }

      logger.info('NOTIFICATION_SERVICE', `Batch delivery complete for user ${userId}: ${response.successCount} success, ${response.failureCount} failure`);
      
      return response;
    } catch (error) {
      logger.error('NOTIFICATION_SERVICE', 'FCM Multicast error:', { error: error.message });
      throw error; // Re-throw to trigger BullMQ retry
    }
  }
}

module.exports = new NotificationService();
