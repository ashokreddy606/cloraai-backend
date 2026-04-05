const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

/**
 * Worker for multi-device notification delivery
 * Configured with concurrency and rate limiting for production stability
 */
const notificationWorker = new Worker(
  QUEUES.NOTIFICATIONS,
  async (job) => {
    const { userId, notificationId } = job.data;
    logger.info('NOTIFICATION_WORKER', `[START] Job:${job.id} | User:${userId} | Notif:${notificationId}`);

    try {
      if (job.name === 'send-notification') {
        const startTime = Date.now();
        const response = await notificationService.processBatchDelivery(job.data);
        const duration = Date.now() - startTime;
        
        logger.info('NOTIFICATION_WORKER', `[SUCCESS] Job:${job.id} | User:${userId} | Time:${duration}ms | Sent:${response.successCount} | Failed:${response.failureCount}`);
        
        return {
          successCount: response.successCount,
          failureCount: response.failureCount,
          durationMs: duration
        };
      }
      
      logger.warn('NOTIFICATION_WORKER', `[SKIP] Unknown job name: ${job.name}`);
    } catch (error) {
      logger.error('NOTIFICATION_WORKER', `[ERROR] Job:${job.id} failed`, { 
        error: error.message,
        attempt: job.attemptsMade + 1
      });
      // Re-throwing triggers BullMQ's automatic exponential backoff retry.
      throw error; 
    }
  },
  {
    connection,
    concurrency: 10, // Process up to 10 notifications in parallel
    limiter: {
      max: 50, // FCM recommended limit per batch to avoid socket exhaustion
      duration: 1000,
    },
    // Ensure jobs are picked up even if the connection was briefly interrupted
    maxRetriesPerRequest: null, 
  }
);

// Worker event handlers for deep monitoring
notificationWorker.on('completed', (job) => {
  // Clean up metadata if needed
});

notificationWorker.on('failed', (job, err) => {
  logger.error('NOTIFICATION_WORKER', `[RETRY_FAILED] Job:${job.id} after max attempts`, { error: err.message });
});

notificationWorker.on('error', (err) => {
  logger.error('NOTIFICATION_WORKER', `[CRITICAL] Worker encounterd a global error`, { error: err.message });
});

module.exports = notificationWorker;
