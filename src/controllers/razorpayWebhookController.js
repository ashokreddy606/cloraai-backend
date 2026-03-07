/**
 * razorpayWebhookController.js
 * Handles ALL Razorpay subscription lifecycle webhook events.
 *
 * SECURITY:  HMAC-SHA256 signature verified on raw body before any processing.
 * IDEMPOTENCY: event.id stored in WebhookEvent table — duplicates are ignored.
 * RACE-SAFE:  Webhook is the single source of truth for plan=ACTIVE + planEndDate.
 *             /verify only provides optimistic UI feedback (does NOT compete here).
 * SILENT-PAYMENT-FIX: getUserIdFromSubId checks User.activeRazorpaySubscriptionId
 *             FIRST, then falls back to PaymentHistory. This means even if the
 *             frontend crashes before /verify, a legitimate charge still activates.
 * ADMIN-GUARD: subscription.charged is skipped if activeRazorpaySubscriptionId is
 *             null, preventing a Razorpay webhook from re-upgrading a user that an
 *             admin intentionally downgraded (and nulled the sub ID).
 *
 * Events handled:
 *   subscription.charged     → set plan=PRO + status=ACTIVE + correct planEndDate
 *   subscription.cancelled   → set status=CANCELLED (access until planEndDate)
 *   subscription.halted      → set status=PAST_DUE
 *   subscription.completed   → set plan=FREE + status=EXPIRED
 *   payment.failed           → log FAILED
 */

const crypto = require('crypto');
const prisma = require('../lib/prisma');

// ─── Webhook Signature Verification ──────────────────────────────────────────
const verifyWebhookSignature = (rawBody, signature, secret) => {
    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
    return expected === signature;
};

// ─── FIX: Dual-path userId lookup ─────────────────────────────────────────────
// Priority 1: User.activeRazorpaySubscriptionId (set in createOrder, always present)
// Priority 2: PaymentHistory fallback (for legacy records before this fix)
// This ensures a payment is NEVER silently dropped even if /verify was never called.
const getUserIdFromSubId = async (subscriptionId) => {
    // Path 1: Direct link on User (set during createOrder)
    const userByActiveSubId = await prisma.user.findFirst({
        where: { activeRazorpaySubscriptionId: subscriptionId },
        select: { userId: undefined, id: true },
    });
    if (userByActiveSubId?.id) return userByActiveSubId.id;

    // Path 2: Fallback via PaymentHistory (legacy / already-processed payments)
    const record = await prisma.paymentHistory.findFirst({
        where: { razorpaySubscriptionId: subscriptionId },
        select: { userId: true },
        orderBy: { createdAt: 'desc' },
    });
    return record?.userId ?? null;
};

// ─── Event Handlers ───────────────────────────────────────────────────────────

const handleReferralReward = async (userId, eventId) => {
    // 1. Fetch the user who just paid, and who invited them
    const newUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, referredById: true, ipAddress: true, deviceFingerprint: true }
    });

    if (!newUser || !newUser.referredById) return; // Not a referred user

    const inviterId = newUser.referredById;

    // 2. Prevent Self-Referral
    if (inviterId === newUser.id) return;

    // 3. Prevent Double Counting (Idempotency on the ReferralTransaction level)
    const existingTransaction = await prisma.referralTransaction.findUnique({
        where: { razorpayEventId: eventId }
    });
    if (existingTransaction) return; // Already processed this payment event for referrals

    // 4. Fraud Detection Sandbox
    const inviter = await prisma.user.findUnique({
        where: { id: inviterId },
        select: { id: true, ipAddress: true, deviceFingerprint: true, isFlagged: true, fraudScore: true }
    });

    if (!inviter || inviter.isFlagged) {
        // If inviter is banned or flagged, log the transaction as BLOCKED and silently return
        await prisma.referralTransaction.create({
            data: {
                inviterId,
                referredUserId: newUser.id,
                razorpayEventId: eventId,
                status: 'BLOCKED',
                fraudReason: 'Inviter is currently flagged or disabled',
                unlocksAt: new Date(Date.now() + 7 * 86400000)
            }
        });
        return;
    }

    let additionalFraudScore = 0;
    let fraudReason = null;

    if (newUser.ipAddress && inviter.ipAddress && newUser.ipAddress === inviter.ipAddress) {
        additionalFraudScore += 30;
        fraudReason = fraudReason ? fraudReason + ' | Shared IP' : 'Shared IP';
    }

    if (newUser.deviceFingerprint && inviter.deviceFingerprint && newUser.deviceFingerprint === inviter.deviceFingerprint) {
        additionalFraudScore += 50;
        fraudReason = fraudReason ? fraudReason + ' | Shared Device' : 'Shared Device';
    }

    // 5. Execute Core Logic inside an Atomic Transaction
    await prisma.$transaction(async (tx) => {
        // A. Record the transaction first (PENDING by default)
        const unlocksAt = new Date(Date.now() + 7 * 86400000); // 7 day maturation
        let txStatus = 'PENDING';

        if (additionalFraudScore >= 30) {
            txStatus = 'BLOCKED';
            await tx.user.update({
                where: { id: inviterId },
                data: {
                    fraudScore: { increment: additionalFraudScore },
                    isFlagged: (inviter.fraudScore + additionalFraudScore) >= 100
                }
            });
        }

        const refTx = await tx.referralTransaction.create({
            data: {
                inviterId,
                referredUserId: newUser.id,
                razorpayEventId: eventId,
                status: txStatus,
                fraudReason,
                unlocksAt
            }
        });

        if (txStatus === 'BLOCKED') {
            console.log(`[Referral] Blocked fraudulent referral from ${inviterId}`);
        } else {
            logger.info('REFERRAL', `Referral reward PENDING for ${inviterId}`, {
                referredUserId: newUser.id,
                eventId
            });
            console.log(`[Referral] Logged PENDING transaction for ${inviterId}. Unlocks in 7 days.`);
        }
    });
};

const handleSubscriptionCharged = async (payload, eventId) => {
    const sub = payload.subscription?.entity;
    const payment = payload.payment?.entity;

    if (!sub?.id) return;

    const subscriptionId = sub.id;
    const currentEnd = sub.current_end; // Unix timestamp from Razorpay
    const planEndDate = new Date(currentEnd * 1000);
    const now = new Date();

    // ── PHASE 2 FIX: Minimum amount validation ───────────────────────────────
    // Reject activation if payment amount is less than expected for PRO plans.
    // Monthly: 19900 (₹199), Yearly: 199900 (₹1999)
    const amountPaid = payment?.amount ?? 0;
    const isYearly = amountPaid > 100000; // Heuristic for yearly
    const minExpected = isYearly ? 199900 : 19900;

    if (amountPaid < minExpected) {
        logger.warn('PAYMENT_SECURITY', `Suspicious payment amount: ${amountPaid} for sub ${subscriptionId}`, {
            userId: await getUserIdFromSubId(subscriptionId),
            eventId
        });
        return; // Reject processing further
    }

    const userId = await getUserIdFromSubId(subscriptionId);

    if (!userId) {
        console.warn(`[Webhook] subscription.charged: No user found for sub ${subscriptionId} — payment dropped!`);
        return;
    }

    // ── FIX: Admin re-upgrade guard ──────────────────────────────────────────
    // If the admin nulled activeRazorpaySubscriptionId during downgrade, this
    // webhook can no longer re-upgrade the user. The guard below catches any edge
    // case where userId was found via PaymentHistory fallback on a nulled user.
    const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { activeRazorpaySubscriptionId: true, manuallyUpgraded: true },
    });

    if (currentUser?.manuallyUpgraded === true && currentUser?.activeRazorpaySubscriptionId === null) {
        console.log(`[Webhook] subscription.charged: Skipping — admin downgraded user ${userId} (sub ID nulled)`);
        return;
    }

    // ── FIX: Complete state transition — always write BOTH plan AND status ────
    await prisma.user.update({
        where: { id: userId },
        data: {
            plan: 'PRO',
            subscriptionStatus: 'ACTIVE',
            planSource: 'RAZORPAY',
            planEndDate: planEndDate,
            manuallyUpgraded: false,
        },
    });

    // ── Upsert PaymentHistory — safe if /verify already created the row ──────
    if (payment?.id) {
        await prisma.paymentHistory.upsert({
            where: { razorpayPaymentId: payment.id },
            update: {
                endDate: planEndDate,
                status: 'SUCCESS',
                paymentMethod: payment.method || undefined,
            },
            create: {
                userId,
                razorpaySubscriptionId: subscriptionId,
                razorpayPaymentId: payment.id,
                amount: payment.amount || 19900,
                currency: payment.currency || 'INR',
                status: 'SUCCESS',
                planName: 'PRO',
                startDate: now,
                endDate: planEndDate,
                paymentMethod: payment.method || null,
            },
        });
    } else {
        console.warn(`[Webhook] subscription.charged: payment entity absent for sub ${subscriptionId}. PaymentHistory not created.`);
    }

    // ── Referral Engine Lifecycle Hook ───────────────────────────────────────
    try {
        await handleReferralReward(userId, eventId);
    } catch (refError) {
        console.error(`[Webhook/Referral] Failed to process referral for user ${userId}:`, refError.message);
        // Do not fail the webhook request if referral handling crashes
    }

    console.log(`[Webhook] subscription.charged: User ${userId} plan set to PRO + ACTIVE until ${planEndDate.toISOString()}`);
};

const handleSubscriptionCancelled = async (payload) => {
    const sub = payload.subscription?.entity;
    if (!sub?.id) return;

    const userId = await getUserIdFromSubId(sub.id);
    if (!userId) return;

    // FIX: Set CANCELLED only — do NOT touch plan. User retains PRO access until
    // planEndDate. Cron will set plan=FREE + status=EXPIRED when time runs out.
    await prisma.user.update({
        where: { id: userId },
        data: { subscriptionStatus: 'CANCELLED' },
    });

    console.log(`[Webhook] subscription.cancelled: User ${userId} — PRO access until planEndDate`);
};

const handleSubscriptionHalted = async (payload) => {
    const sub = payload.subscription?.entity;
    if (!sub?.id) return;

    const userId = await getUserIdFromSubId(sub.id);
    if (!userId) return;

    await prisma.user.update({
        where: { id: userId },
        data: { subscriptionStatus: 'PAST_DUE' },
    });

    console.log(`[Webhook] subscription.halted: User ${userId} moved to PAST_DUE`);
};

const handleSubscriptionCompleted = async (payload) => {
    const sub = payload.subscription?.entity;
    if (!sub?.id) return;

    const userId = await getUserIdFromSubId(sub.id);
    if (!userId) return;

    // Check plan first — do NOT touch LIFETIME users
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { plan: true },
    });
    if (user?.plan === 'LIFETIME') {
        console.log(`[Webhook] subscription.completed: Skipping LIFETIME user ${userId}`);
        return;
    }

    // FIX: Set BOTH plan=FREE AND status=EXPIRED together. Previous code only
    // set subscriptionStatus, leaving plan=PRO permanently (state machine bug).
    await prisma.user.update({
        where: { id: userId },
        data: {
            plan: 'FREE',
            subscriptionStatus: 'EXPIRED',
            activeRazorpaySubscriptionId: null, // Clean up link
        },
    });

    console.log(`[Webhook] subscription.completed: User ${userId} → plan=FREE, status=EXPIRED`);
};

const handlePaymentFailed = async (payload) => {
    const payment = payload.payment?.entity;
    const subId = payment?.subscription_id;
    if (!payment?.id) return;

    if (subId) {
        const userId = await getUserIdFromSubId(subId);
        if (userId) {
            await prisma.paymentHistory.upsert({
                where: { razorpayPaymentId: payment.id },
                update: { status: 'FAILED' },
                create: {
                    userId,
                    razorpaySubscriptionId: subId,
                    razorpayPaymentId: payment.id,
                    amount: payment.amount || 0,
                    currency: payment.currency || 'INR',
                    status: 'FAILED',
                    planName: 'PRO',
                    paymentMethod: payment.method || null,
                },
            });
            console.log(`[Webhook] payment.failed: Logged for user ${userId}`);
        }
    }
};

// ─── Main Webhook Handler ─────────────────────────────────────────────────────
/**
 * POST /api/webhook/razorpay
 * No JWT auth — validated via HMAC-SHA256 signature on raw body.
 * MUST be registered with express.raw({ type: 'application/json' }) in server.js
 */
const handleRazorpayWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    if (!secret) {
        console.error('[CRITICAL] RAZORPAY_WEBHOOK_SECRET is not set!');
        return res.status(500).send('Webhook configuration error');
    }

    if (!signature) {
        return res.status(400).send('Missing signature header');
    }

    const rawBody = req.body; // Buffer (express.raw)

    if (!verifyWebhookSignature(rawBody, signature, secret)) {
        console.warn('[Security] Invalid Razorpay webhook signature — rejected');
        return res.status(403).send('Invalid signature');
    }

    let event;
    try {
        event = JSON.parse(rawBody.toString());
    } catch {
        return res.status(400).send('Invalid JSON body');
    }

    // ── SECTION 7: Idempotency via event.id ──────────────────────────────────
    // WebhookEvent has @unique on eventId. A duplicate delivery causes a P2002
    // unique constraint error, which we catch and respond 200 to (tell Razorpay
    // not to retry). This is the correct idempotency pattern.
    const eventId = event.id;
    const eventName = event.event;

    if (eventId) {
        try {
            await prisma.webhookEvent.create({
                data: { eventId, eventType: eventName || 'unknown' },
            });
        } catch (uniqueError) {
            // P2002 = unique constraint — this event was already processed
            console.log(`[Webhook] Duplicate event ${eventId} (${eventName}) — skipping`);
            return res.status(200).send('OK'); // Acknowledge — do not retry
        }
    }

    // Acknowledge Razorpay IMMEDIATELY (< 5s SLA required)
    res.status(200).send('OK');

    // Process async AFTER acknowledging — response is already sent
    const payload = event.payload;

    try {
        switch (eventName) {
            case 'subscription.charged':
                await handleSubscriptionCharged(payload, eventId);
                break;
            case 'subscription.cancelled':
                await handleSubscriptionCancelled(payload);
                break;
            case 'subscription.halted':
                await handleSubscriptionHalted(payload);
                break;
            case 'subscription.completed':
                await handleSubscriptionCompleted(payload);
                break;
            case 'payment.failed':
                await handlePaymentFailed(payload);
                break;
            default:
                console.log(`[Webhook] Unhandled event: ${eventName}`);
        }
    } catch (err) {
        // Never rethrow — response already sent to Razorpay
        console.error(`[Webhook] Error processing ${eventName}:`, err.message);
    }
};

module.exports = { handleRazorpayWebhook };
