const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

/**
 * Demo: Using the Production-Ready FCM System
 */
async function runDemo() {
  const testUserId = '65f1a2b3c4d5e6f7a8b9c0d1'; // Example MongoDB ID
  const testFcmToken = 'fcm_token_here'; // Replace with a real device token for testing

  console.log('--- CloraAI Notification System Demo ---');

  // 1. Send to User (Queued, Retriable, Idempotent)
  // This is the preferred method for app logic.
  try {
    console.log('\n[1] Sending Queued Notification to User...');
    const notif = await notificationService.sendToUser(testUserId, {
      title: '🚀 Production Test',
      body: 'This notification was sent via the BullMQ queue with 3 retries configured.',
      data: {
        type: 'DEMO',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK', // Custom intent
        imageUrl: 'https://clora.ai/assets/promo-banner.png' // Rich Media
      },
      priority: 'high' // Faster delivery
    });
    console.log('Success: Notification record created and enqueued:', notif._id);
  } catch (error) {
    console.error('Failed to enqueue user notification:', error.message);
  }

  // 2. Direct Send to Token (Synchronous, One-off)
  // Best for system alerts or testing a specific device.
  try {
    console.log('\n[2] Sending Direct Notification to Token...');
    const result = await notificationService.sendToToken(
      testFcmToken,
      '🎯 Direct Hit!',
      'This bypassed the queue and went straight to FCM v1.',
      {
        channelId: 'alerts',
        imageUrl: 'https://clora.ai/assets/alert-icon.png'
      }
    );
    console.log('Success: FCM Message ID:', result.messageId);
  } catch (error) {
    // Note: If token is invalid, it is automatically purged from DB here.
    console.error('Failed direct send:', error.message);
  }
}

// runDemo(); // Uncomment to run if Redis/Mongo are connected
module.exports = runDemo;
