const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

/**
 * Worker for multi-device notification delivery
 */
const notificationWorker = new Worker(
  QUEUES.NOTIFICATIONS,
  async (job) => {
    logger.info('NOTIFICATION_WORKER', `Processing notification job: ${job.id} (user: ${job.data.userId})`);

    try {
      if (job.name === 'send-notification') {
        const { userId, tokens, payload } = job.data;

        if (!tokens || tokens.length === 0) {
          logger.warn('NOTIFICATION_WORKER', `No tokens provided for notification ${job.id} for user ${userId}. Job skipped.`);
          return;
        }

        // Handle batch delivery and auto-token-cleanup
        const response = await notificationService.processBatchDelivery(job.data);
        
        return {
          successCount: response.successCount,
          failureCount: response.failureCount,
        };
      }
    } catch (error) {
      logger.error('NOTIFICATION_WORKER', `Job failed: ${job.id}`, { error: error.message });
      throw error; // Re-throw to trigger BullMQ retry with backoff
    }
  },
  {
    connection,
    concurrency: 5, // Process multiple notifications in parallel
    limiter: {
      max: 100, // Max 100 notifications per 1 second (burst)
      duration: 1000,
    },
  }
);

// Worker event handlers
notificationWorker.on('completed', (job) => {
  logger.info('NOTIFICATION_WORKER', `✅ Job completed: ${job.id}`);
});

notificationWorker.on('failed', (job, err) => {
  logger.error('NOTIFICATION_WORKER', `❌ Job failed: ${job.id}`, { error: err.message });
});

module.exports = notificationWorker;
