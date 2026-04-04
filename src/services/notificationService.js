const DeviceToken = require('../models/DeviceToken');
const Notification = require('../models/Notification');
const { notificationQueue, enqueueJob } = require('../utils/queue');
const { admin } = require('../lib/firebase');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const redis = require('../lib/redis');

/**
 * Service to handle multi-device notifications
 */
class NotificationService {
  /**
   * Helper: Acquire a Redis lock for idempotency
   * @param {string} notificationId 
   * @param {number} expirySeconds 
   * @returns {Promise<boolean>} True if lock acquired, False if already exists
   */
  async acquireLock(notificationId, expirySeconds = 60) {
    if (!notificationId) return true; // No ID, no lock needed
    const lockKey = `notification_lock:${notificationId}`;
    try {
      // SET NX = Set if Not eXists, EX = EXpirty in seconds
      const result = await redis.set(lockKey, 'true', 'NX', 'EX', expirySeconds);
      return result === 'OK';
    } catch (error) {
      logger.error('NOTIFICATION_SERVICE', `Redis lock error for ${notificationId}:`, { error: error.message });
      return true; // Fallback: allow if Redis is down
    }
  }

  /**
   * Register or Update a device token for a user
   */
  async registerDevice(userId, { deviceId, fcmToken, platform }) {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const device = await DeviceToken.findOneAndUpdate(
        { userId: userObjectId, deviceId },
        { fcmToken, platform, lastActive: new Date() },
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
   * Trigger a notification for a user (Enterprise Logic)
   * Deduplication: Redis Lock -> MongoDB Check -> Token Check
   */
  async sendToUser(userId, { title, body, data = {}, notificationId = null, priority = 'normal' }) {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // 1. REDIS IDEMPOTENCY LOCK
      if (notificationId) {
        const lockAcquired = await this.acquireLock(notificationId);
        if (!lockAcquired) {
          logger.warn('NOTIFICATION_SERVICE', `SKIP: Duplicate request intercepted by Redis lock: ${notificationId}`);
          return null;
        }
      }

      // 2. MONGODB DEDUPLICATION CHECK
      if (notificationId) {
        const existing = await Notification.findOne({ notificationId, userId: userObjectId });
        if (existing) {
          logger.warn('NOTIFICATION_SERVICE', `SKIP: Duplicate request found in DB: ${notificationId}`);
          return existing;
        }
      }

      // 3. FETCH AND VALIDATE TOKENS
      const devices = await DeviceToken.find({ userId: userObjectId });
      if (!devices || devices.length === 0) {
        logger.warn('NOTIFICATION_SERVICE', `FALLBACK: No active devices for user ${userId}. Skipping FCM.`);
        // Still save to DB so user can see it in history later
        return await Notification.create({
          userId: userObjectId,
          title,
          body,
          data,
          notificationId
        });
      }

      // 4. STORE IN HISTORY
      const notification = await Notification.create({
        userId: userObjectId,
        title,
        body,
        data,
        notificationId
      });

      const tokens = devices.map(d => d.fcmToken).filter(t => !!t);

      // 5. ENQUEUE FOR BACKGROUND PROCESSING
      const jobData = {
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
              aps: { contentAvailable: true, badge: 1 }
            }
          }
        }
      };

      const enqueued = await enqueueJob(notificationQueue, 'send-notification', jobData, {
        priority: priority === 'high' ? 1 : 10 // BullMQ priority (lower is higher)
      });

      // 6. FALLBACK: If queue is down, send directly (Ensures 0% loss)
      if (!enqueued) {
        logger.warn('NOTIFICATION_SERVICE', `FALLBACK: Queue failed for user ${userId}. Sending directly...`);
        await this.processBatchDelivery(jobData);
      }

      return notification;
    } catch (error) {
      logger.error('NOTIFICATION_SERVICE', 'Error triggering notification:', { error: error.message });
      throw error;
    }
  }

  /**
   * Batch send notifications (used by worker or fallback)
   * Handles invalid/expired tokens automatically
   */
  async processBatchDelivery(jobData) {
    const { tokens, payload, userId } = jobData;
    
    if (!tokens || tokens.length === 0) {
      logger.info('NOTIFICATION_SERVICE', `Delivery skipped for user ${userId}: No tokens.`);
      return { successCount: 0, failureCount: 0 };
    }

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        ...payload
      });

      const tokensToRemove = [];
      
      response.responses.forEach((res, idx) => {
        if (!res.success) {
          const error = res.error;
          if (error.code === 'messaging/registration-token-not-registered' || 
              error.code === 'messaging/invalid-registration-token') {
            tokensToRemove.push(tokens[idx]);
          }
          logger.warn('NOTIFICATION_SERVICE', `FCM Delivery failed for user ${userId}: ${error.code} (${error.message})`, { token: tokens[idx] });
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
      logger.error('NOTIFICATION_SERVICE', `FCM Multicast FATAL error for user ${userId}:`, { error: error.message });
      throw error; // Re-throw to trigger BullMQ retry
    }
  }

  async removeDevice(userId, deviceId) {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    await DeviceToken.deleteOne({ userId: userObjectId, deviceId });
    logger.info('NOTIFICATION_SERVICE', `Device removed: ${userId} -> ${deviceId}`);
  }

  async getUserDevices(userId) {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    return await DeviceToken.find({ userId: userObjectId }).sort({ lastActive: -1 });
  }
}

module.exports = new NotificationService();
