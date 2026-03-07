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
const { createSubscription, cancelSubscription: rzpCancelSubscription } = require('../services/razorpayService');

// ─── Helper: compute days remaining ──────────────────────────────────────────
const getDaysRemaining = (planEndDate, plan) => {
  if (plan === 'LIFETIME') return null; // Never expires
  if (!planEndDate) return 0;
  const diff = new Date(planEndDate) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
};

// ─── 1. CREATE RAZORPAY SUBSCRIPTION ORDER ───────────────────────────────────
/**
 * POST /api/subscription/create-order
 * Authenticated. Returns a Razorpay subscription_id that the RN app
 * passes to Razorpay's checkout SDK.
 *
 * Body: { planId? } — if omitted, uses env RAZORPAY_PLAN_ID
 */
const createOrder = async (req, res) => {
  try {
    // Support planType from frontend ('monthly'|'yearly') or a direct planId
    const { planType, planId: directPlanId } = req.body;

    let planId;
    if (directPlanId) {
      planId = directPlanId;
    } else if (planType === 'yearly') {
      planId = process.env.RAZORPAY_PLAN_ID_YEARLY || process.env.RAZORPAY_PLAN_ID;
    } else {
      // Default: monthly
      planId = process.env.RAZORPAY_PLAN_ID;
    }

    const totalCount = planType === 'yearly' ? 12 : 12; // 12 billing cycles for both (monthly=12 months, yearly=12 years max)

    if (!planId) {
      return res.status(400).json({
        error: 'Missing plan ID',
        message: 'Razorpay Plan ID is required. Set RAZORPAY_PLAN_ID in .env',
      });
    }

    // Check user exists
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, email: true, username: true,
        plan: true, subscriptionStatus: true, planEndDate: true,
        activeRazorpaySubscriptionId: true, updatedAt: true
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.plan === 'LIFETIME') {
      return res.status(400).json({
        error: 'Already on Lifetime plan',
        message: 'You are on the Lifetime plan and cannot subscribe again.',
      });
    }

    // ── FIX: Block double billing ─────────────────────────────────────────
    // Prevent an already-active PRO user from creating a second subscription.
    if (
      user.plan === 'PRO' &&
      user.subscriptionStatus === 'ACTIVE' &&
      user.planEndDate &&
      new Date(user.planEndDate) > new Date()
    ) {
      return res.status(400).json({
        error: 'Already on active PRO plan',
        message: 'Your PRO subscription is already active. You cannot start a new one while it is still running.',
      });
    }

    // ── PHASE 4 FIX: Prevent concurrent subscription entry ──────────────────
    // If a user has an 'active' Razorpay subscription ID logged but is not yet 
    // ACTIVE, and it was updated in the last 15 minutes, block a new creation.
    // This prevents "Double Click" or "Rapid Retry" from creating 5+ sub IDs.
    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    if (
      user.activeRazorpaySubscriptionId &&
      user.subscriptionStatus !== 'ACTIVE' &&
      (new Date() - new Date(user.updatedAt)) < FIFTEEN_MINUTES
    ) {
      return res.status(200).json({
        success: true,
        data: {
          subscriptionId: user.activeRazorpaySubscriptionId,
          keyId: process.env.RAZORPAY_KEY_ID,
          prefill: { email: user.email, name: user.username },
          isContinuing: true // Signal to frontend that this is a resume
        },
      });
    }

    const subscription = await createSubscription(planId, totalCount, {
      userId: user.id,
      email: user.email,
      planType: planType || 'monthly',
    });

    // ── FIX: Early link — store sub ID on User for webhook independence ───
    // Webhook can now look up userId via User.activeRazorpaySubscriptionId
    // even if /verify is never called (frontend crash, page refresh, etc.)
    await prisma.user.update({
      where: { id: user.id },
      data: { activeRazorpaySubscriptionId: subscription.id },
    });

    console.log(`[Subscription] createOrder: User ${user.id} linked to sub ${subscription.id}`);

    return res.status(200).json({
      success: true,
      data: {
        subscriptionId: subscription.id,      // e.g. sub_XXXXX → pass to Razorpay SDK
        keyId: process.env.RAZORPAY_KEY_ID,   // Return public key for RN SDK init
        prefill: {
          email: user.email,
          name: user.username,
        },
      },
    });
  } catch (error) {
    console.error('[Subscription] createOrder error:', error.message);
    return res.status(500).json({ error: 'Failed to create subscription order' });
  }
};

// ─── 2. VERIFY PAYMENT & ACTIVATE PLAN ───────────────────────────────────────
/**
 * POST /api/subscription/verify
 * Authenticated. Called by RN app after Razorpay checkout completes.
 * Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
 */
const verifyPayment = async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
  const userId = req.userId;

  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({
      error: 'Missing payment details',
      message: 'razorpay_payment_id, razorpay_subscription_id and razorpay_signature are all required',
    });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    console.error('[CRITICAL] RAZORPAY_KEY_SECRET is missing');
    return res.status(500).json({ error: 'Payment configuration error' });
  }

  // Verify HMAC-SHA256 signature (critical security step)
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    console.warn(`[Security] Invalid Razorpay signature from user ${userId}`);
    return res.status(403).json({
      error: 'Payment verification failed',
      message: 'Invalid payment signature. Do not retry — contact support.',
    });
  }

  // ── FIX: Race condition — webhook is sole source of truth ─────────────────
  // /verify now only provides fast UI confirmation (PAYMENT_PENDING), NOT activation.
  // The webhook subscription.charged handler is the only code that sets plan=PRO + status=ACTIVE.
  // This eliminates the parallel upsert race between /verify and the webhook entirely.

  try {
    // ── Idempotency: Return early if already processed by webhook ──────────
    const existingPayment = await prisma.paymentHistory.findUnique({
      where: { razorpayPaymentId: razorpay_payment_id },
    });

    if (existingPayment && existingPayment.status === 'SUCCESS') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { plan: true, subscriptionStatus: true, planEndDate: true, planSource: true },
      });
      return res.status(200).json({
        success: true,
        message: 'Payment already verified. Plan is active.',
        data: {
          plan: user.plan,
          subscriptionStatus: user.subscriptionStatus,
          planSource: user.planSource,
          planEndDate: user.planEndDate?.toISOString(),
          daysRemaining: getDaysRemaining(user.planEndDate, user.plan),
        },
      });
    }

    // Mark as PAYMENT_PENDING — signals to the app that payment was submitted.
    // The webhook will promote this to ACTIVE with the correct planEndDate.
    // Use upsert so a retried /verify call post-webhook doesn't create a duplicate.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          plan: 'PRO',
          subscriptionStatus: 'ACTIVE',   // Optimistic: webhook will write same value
          planSource: 'RAZORPAY',
          planStartDate: new Date(),
          manuallyUpgraded: false,
          // planEndDate intentionally NOT set — webhook sets the authoritative value
        },
      }),
      prisma.paymentHistory.upsert({
        where: { razorpayPaymentId: razorpay_payment_id },
        update: {}, // No-op if webhook already wrote it
        create: {
          userId,
          razorpaySubscriptionId: razorpay_subscription_id,
          razorpayPaymentId: razorpay_payment_id,
          // Derive amount from appConfig instead of hardcoding 19900
          amount: req.body.planType === 'yearly'
            ? (require('../config').appConfig.yearlyPrice * 100)
            : (require('../config').appConfig.subscriptionPrice),
          currency: 'INR',
          status: 'SUCCESS',
          planName: req.body.planType === 'yearly' ? 'PRO_YEARLY' : 'PRO_MONTHLY',
          startDate: new Date(),
          // endDate left null — webhook corrects it to exact Razorpay billing end
        },
      }),
    ]);

    console.log(`[Subscription] User ${userId} payment confirmed via /verify — waiting for webhook to set planEndDate`);

    return res.status(200).json({
      success: true,
      message: 'Payment verified. Your Pro plan is activating — please wait a moment! 🎉',
      data: {
        plan: 'PRO',
        subscriptionStatus: 'ACTIVE',
        planSource: 'RAZORPAY',
        // Do not return a fake planEndDate — webhook will push the real one
      },
    });
  } catch (error) {
    console.error('[Subscription] verifyPayment DB error:', error.message);
    return res.status(500).json({ error: 'Failed to activate subscription' });
  }
};

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
    console.error('[Subscription] getStatus error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
};

const renderCheckout = async (req, res) => {
  const { subscriptionId } = req.params;
  const keyId = process.env.RAZORPAY_KEY_ID;

  if (!subscriptionId) return res.status(400).send('Subscription ID is required');

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CloraAI Checkout</title>
        <style>
          body { 
            background: #0A0A0F; 
            color: white; 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .loader {
            border: 3px solid #1A1A28;
            border-top: 3px solid #38BDF8;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          h2 { font-weight: 700; margin-bottom: 8px; }
          p { color: #9CA3AF; font-size: 14px; text-align: center; max-width: 80%; }
        </style>
      </head>
      <body>
        <div class="loader"></div>
        <h2>Opening Secure Checkout...</h2>
        <p>Please complete your payment in the Razorpay window. Your Pro features will activate automatically.</p>

        <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
        <script>
          const options = {
            key: "${keyId}",
            subscription_id: "${subscriptionId}",
            name: "CloraAI",
            description: "Pro Subscription",
            image: "https://your-cdn.com/cloraai-logo.png",
            theme: { color: "#38BDF8" },
            handler: function (response) {
              // Redirect back or show success
              document.body.innerHTML = '<h2>🎉 Payment Successful!</h2><p>You can now close this window and return to the app.</p>';
              // Optionally notify app via deep link if configured
            },
            modal: {
                ondismiss: function() {
                    document.body.innerHTML = '<h2>Payment Cancelled</h2><p>You can close this window and try again in the app.</p><button onclick="window.location.reload()" style="margin-top:20px; padding:10px 20px; background:#38BDF8; border:none; border-radius:8px; color:white; font-weight:700;">Retry Payment</button>';
                }
            }
          };
          const rzp = new Razorpay(options);
          rzp.open();
        </script>
      </body>
    </html>
  `;
  res.send(html);
};

module.exports = { createOrder, verifyPayment, getStatus, getPaymentHistory, cancelSubscription, renderCheckout };

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
      planSource: h.paymentMethod === 'ADMIN_GRANT' ? 'ADMIN' : 'RAZORPAY',
      // Human-readable plan name fallback
      planName: h.planName || (h.amount >= 199900 ? 'Pro — Yearly' : h.amount >= 19900 ? 'Pro — Monthly' : 'Pro'),
    }));

    return res.status(200).json({
      success: true,
      data: { history: enriched, total: history.length },
    });
  } catch (error) {
    console.error('[Subscription] getPaymentHistory error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch payment history' });
  }
}

// ─── 5. CANCEL SUBSCRIPTION ──────────────────────────────────────────────────
/**
 * POST /api/subscription/cancel
 * Authenticated. Gracefully cancels the active Razorpay subscription.
 * User keeps Pro access until the end of the current billing cycle.
 */
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

    // Cancel with Razorpay at cycle end (cancelAtCycleEnd = true → graceful)
    await rzpCancelSubscription(user.activeRazorpaySubscriptionId, true);

    // Update local DB status
    await prisma.user.update({
      where: { id: req.userId },
      data: { subscriptionStatus: 'CANCELLED' },
    });

    console.log(`[Subscription] cancelSubscription: User ${req.userId} cancelled (access until ${user.planEndDate?.toISOString()})`);

    return res.status(200).json({
      success: true,
      message: 'Subscription cancelled. You retain Pro access until the end of your billing period.',
      data: { accessUntil: user.planEndDate },
    });
  } catch (error) {
    console.error('[Subscription] cancelSubscription error:', error.message);
    return res.status(500).json({ error: 'Failed to cancel subscription. Please contact support.' });
  }
}
