const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const notificationService = require('../services/notificationService');
const pushNotificationService = require('../services/pushNotificationService');
const transporter = require('../config/mail');

/**
 * sendEmail function extracted from authController for worker use
 */
const sendMailInternal = async ({ to, subject, html }) => {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'CloraAI <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(`Resend error: ${JSON.stringify(data)}`);
    }
    return true;
  }

  // Fallback to Nodemailer transporter from config
  return transporter.sendMail({
    from: process.env.EMAIL_FROM || `"CloraAI" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
};

/**
 * Auth Worker
 * Processes non-critical authentication tasks in the background.
 */
const authWorker = new Worker(
  QUEUES.AUTH,
  async (job) => {
    const { type, data } = job.data;
    logger.info('AUTH_WORKER', `[START] Job:${job.id} | Type:${type}`);

    try {
      switch (job.name) {
        case 'process-registration': {
          const { user, inviter, emailHtml } = data;
          
          // 1. Send Welcome/Verification Email
          await sendMailInternal({ to: user.email, subject: 'Welcome to CloraAI - Verify Email', html: emailHtml });
          
          // 2. Handle Referral Logic (if applicable)
          if (user.referredById) {
            await prisma.user.update({
              where: { id: user.referredById },
              data: { totalReferrals: { increment: 1 } }
            });
            
            if (inviter) {
              await pushNotificationService.notifyReferralSuccess(user.referredById, user.username || user.email.split('@')[0]).catch(err => 
                logger.warn('AUTH_WORKER:REFERRAL_ERROR', 'Failed to send referral notification', { error: err.message, referrerId: user.referredById })
              );
            }
          }
          break;
        }

        case 'register-device': {
          const { userId, registrationData } = data;
          await notificationService.registerDevice(userId, registrationData);
          break;
        }

        case 'process-login-side-effects': {
            const { userId, fcmToken, deviceId, platform, pushToken, deviceName, deviceType, os } = data;
            
            // 1. Register FCM Device
            if (fcmToken) {
                await notificationService.registerDevice(userId, {
                  deviceId: deviceId || 'unknown',
                  fcmToken: fcmToken,
                  platform: platform || 'web'
                }).catch(err => logger.error('AUTH_WORKER:FCM', 'Failed to register FCM device', { error: err.message }));
            }

            // 2. Register Expo Push Token
            if (pushToken && pushNotificationService.isLikelyExpoToken(pushToken)) {
                await prisma.deviceToken.upsert({
                  where: { token: pushToken },
                  create: {
                    token: pushToken,
                    userId: userId,
                    deviceName,
                    deviceType,
                    os,
                    lastUsed: new Date()
                  },
                  update: {
                    userId: userId, 
                    lastUsed: new Date(),
                    deviceName,
                    os
                  }
                });
            }
            break;
        }

        default:
          logger.warn('AUTH_WORKER', `[SKIP] Unknown job name: ${job.name}`);
      }
    } catch (error) {
      logger.error('AUTH_WORKER', `[ERROR] Job:${job.id} failed`, { error: error.message });
      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

module.exports = authWorker;
