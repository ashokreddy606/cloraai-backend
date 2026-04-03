/**
 * subscriptionController.js
 * Razorpay-native subscription management for CloraAI.
 *
 * Endpoints:
 *   POST /api/subscription/create-order  — Create Razorpay subscription, return sub_id to RN app
 *   POST /api/subscription/verify        — Verify payment signature, activate user plan
 *   GET  /api/subscription/status        — Get current plan, status, daysRemaining, planSource
 */

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const googlePlayService = require('../services/googlePlayService');
const { cache } = require('../utils/cache');
const logger = require('../utils/logger');
const pushNotificationService = require('../services/pushNotificationService');

// ─── Helper: compute days remaining ──────────────────────────────────────────
const getDaysRemaining = (planEndDate, plan) => {
  if (plan === 'LIFETIME') return null; // Never expires
  if (!planEndDate) return 0;
  const diff = new Date(planEndDate) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
};

// Razorpay logic removed - Google Play Billing is now the primary monetization system.

// ─── 3. GET SUBSCRIPTION STATUS ──────────────────────────────────────────────
/**
 * GET /api/subscription/status
 * Authenticated. Returns the user's current plan state.
 * This is a lightweight single-row read — no joins.
 */
const getStatus = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        plan: true,
        subscriptionStatus: true,
        planSource: true,
        planStartDate: true,
        planEndDate: true,
        manuallyUpgraded: true,
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Lazy expiry check — if planEndDate passed but status still ACTIVE, downgrade in-request
    if (
      user.plan === 'PRO' &&
      user.subscriptionStatus === 'ACTIVE' &&
      user.planEndDate &&
      new Date(user.planEndDate) < new Date()
    ) {
      await prisma.user.update({
        where: { id: req.userId },
        data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' },
      });
      user.plan = 'FREE';
      user.subscriptionStatus = 'EXPIRED';
    }

    const daysRemaining = getDaysRemaining(user.planEndDate, user.plan);

    return res.status(200).json({
      success: true,
      data: {
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        planSource: user.planSource,
        planStartDate: user.planStartDate,
        planEndDate: user.planEndDate,
        daysRemaining,
        isActive: user.plan !== 'FREE' && user.subscriptionStatus === 'ACTIVE',
        manuallyUpgraded: user.manuallyUpgraded,
      },
    });
  } catch (error) {
    logger.error('SUBSCRIPTION', 'getStatus error', { error: error.message, userId: req.userId });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Razorpay checkout rendering removed.

const verifyGooglePlayPurchase = async (req, res) => {
  const { purchaseToken, productId, packageName } = req.body;
  const userId = req.userId;

  if (!purchaseToken || !productId) {
    return res.status(400).json({ error: 'Missing purchaseToken or productId' });
  }

  try {
    // ── Idempotency Check ──
    const existingPayment = await prisma.paymentHistory.findUnique({
      where: { transactionId: purchaseToken },
    });

    if (existingPayment && existingPayment.status === 'SUCCESS') {
      return res.status(200).json({ success: true, message: 'Purchase already processed' });
    }

    const isSubscription = productId.includes('pro');
    let verificationResult;

    if (isSubscription) {
      verificationResult = await googlePlayService.verifySubscription(packageName || 'com.cloraai.app', productId, purchaseToken);
      
      if (verificationResult.success && verificationResult.active) {
        // Update user to PRO
        const expiryDate = new Date(parseInt(verificationResult.data.expiryTimeMillis));
        
        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              plan: 'PRO',
              subscriptionStatus: 'ACTIVE',
              planSource: 'GOOGLE_PLAY',
              planEndDate: expiryDate,
            }
          }),
          prisma.paymentHistory.create({
            data: {
              userId,
              amount: productId === 'cloraai_pro_yearly' ? 169900 : 19900, // Hardcoded for now based on PRD, should ideally fetch from DB/config
              currency: 'INR',
              status: 'SUCCESS',
              planName: productId === 'cloraai_pro_yearly' ? 'PRO_YEARLY' : 'PRO_MONTHLY',
              paymentMethod: 'GOOGLE_PLAY',
              transactionId: purchaseToken,
            }
          })
        ]);
        
        await cache.clearUserCache(userId);

        // Notify User
        await pushNotificationService.notifySubscriptionSuccess(userId, productId === 'cloraai_pro_yearly' ? 'Pro Yearly' : 'Pro Monthly').catch(err => 
          logger.warn('SUBSCRIPTION:NOTIFY_ERROR', 'Failed to send subscription notification', { error: err.message, userId })
        );

        return res.status(200).json({ success: true, message: 'Subscription activated' });
      }
    } else {
      // Consumable (Credits)
      verificationResult = await googlePlayService.verifyProduct(packageName || 'com.cloraai.app', productId, purchaseToken);
      
      if (verificationResult.success && verificationResult.purchased) {
        // Consume it so user can buy again later
        await googlePlayService.consumeProduct(packageName || 'com.cloraai.app', productId, purchaseToken);
        
        const creditCount = productId === 'cloraai_500_credits' ? 500 : 100;
        
        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              credits: { increment: creditCount }
            }
          }),
          prisma.paymentHistory.create({
            data: {
              userId,
              amount: productId === 'cloraai_500_credits' ? 39900 : 9900,
              currency: 'INR',
              status: 'SUCCESS',
              planName: `CREDITS_${creditCount}`,
              paymentMethod: 'GOOGLE_PLAY',
              transactionId: purchaseToken,
            }
          })
        ]);
        
        await cache.clearUserCache(userId);

        // Notify User
        await pushNotificationService.notifyCreditsAdded(userId, creditCount).catch(err => 
          logger.warn('SUBSCRIPTION:NOTIFY_ERROR', 'Failed to send credit notification', { error: err.message, userId })
        );

        return res.status(200).json({ success: true, message: `${creditCount} credits added` });
      }
    }

    return res.status(400).json({ success: false, error: 'Verification failed or purchase inactive' });
  } catch (error) {
    logger.error('SUBSCRIPTION', 'Google Play verify error', { error: error.message, userId, productId });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = { verifyGooglePlayPurchase, getStatus, getPaymentHistory, cancelSubscription };

// ─── 4. GET PAYMENT HISTORY ──────────────────────────────────────────────────
/**
 * GET /api/subscription/history
 * Returns user's PaymentHistory records (Razorpay transactions) newest-first.
 * Used by the Transaction History screen in the RN app.
 */
async function getPaymentHistory(req, res) {
  try {
    const history = await prisma.paymentHistory.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        transactionId: true,
        razorpayPaymentId: true,
        razorpaySubscriptionId: true,
        amount: true,
        currency: true,
        status: true,
        planName: true,
        startDate: true,
        endDate: true,
        paymentMethod: true,
        createdAt: true,
      },
    });

    const enriched = history.map((h) => ({
      ...h,
      // Identify the source so frontend can show correct icon/label
      planSource: h.paymentMethod || 'RAZORPAY',
      // Human-readable plan name fallback
      planName: h.planName || (h.amount >= 199900 ? 'Pro — Yearly' : h.amount >= 19900 ? 'Pro — Monthly' : 'Pro'),
    }));

    return res.status(200).json({
      success: true,
      data: { history: enriched, total: history.length },
    });
  } catch (error) {
    logger.error('SUBSCRIPTION', 'getPaymentHistory error', { error: error.message, userId: req.userId });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// Google Play subscriptions are managed via Play Store natively.
// Local cancellation just marks user intent if needed, but the source of truth is Play Store.
async function cancelSubscription(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        plan: true,
        subscriptionStatus: true,
        planEndDate: true,
        activeRazorpaySubscriptionId: true,
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.plan === 'FREE') {
      return res.status(400).json({ error: 'No active subscription to cancel' });
    }

    if (user.subscriptionStatus === 'CANCELLED') {
      return res.status(400).json({
        error: 'Already cancelled',
        message: 'Your subscription is already cancelled. Access continues until the billing period ends.',
        data: { accessUntil: user.planEndDate },
      });
    }

    if (!user.activeRazorpaySubscriptionId) {
      // Admin-granted plan — cancel locally only
      await prisma.user.update({
        where: { id: req.userId },
        data: { subscriptionStatus: 'CANCELLED' },
      });
      return res.status(200).json({
        success: true,
        message: 'Subscription cancelled.',
        data: { accessUntil: user.planEndDate },
      });
    }

    // For Google Play Billing, cancellation is handled via Play Store UI.
    // We just mark the local state if the user expresses intent.
    await prisma.user.update({
      where: { id: req.userId },
      data: { subscriptionStatus: 'CANCELLED' },
    });

    logger.info('SUBSCRIPTION', `User ${req.userId} cancelled subscription locally`, { userId: req.userId, accessUntil: user.planEndDate });
    await cache.clearUserCache(req.userId);

    return res.status(200).json({
      success: true,
      message: 'Subscription cancelled. You retain Pro access until the end of your billing period.',
      data: { accessUntil: user.planEndDate },
    });
  } catch (error) {
    logger.error('SUBSCRIPTION', 'cancelSubscription error', { error: error.message, userId: req.userId });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
