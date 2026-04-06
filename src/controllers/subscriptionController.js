/**
 * controllers/subscriptionController.js
 * Full implementation of Recurring Subscription System (Netflix model).
 */

const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { cache } = require('../utils/cache');

/**
 * 1. Create Subscription API
 * POST /api/v1/subscription/create
 * Body: { billingCycle: 'MONTHLY' | 'YEARLY' }
 */
const createSubscription = async (req, res) => {
    try {
        const { type } = req.body;
        const userId = req.userId;
        
        // 0. Normalize the Plan Type (monthly/yearly)
        const normalizedType = type?.toString().toLowerCase();
        logger.info('RAZORPAY_INIT', `Received type: "${type}", Standardized to: "${normalizedType}"`);

        // 1. Get User Data
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, username: true, razorpayCustomerId: true }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // 2. Map to your specific Environment Variables
        // monthly -> RAZORPAY_PLAN_ID
        // yearly -> RAZORPAY_PLAN_ID_YEARLY
        const planId = normalizedType === 'monthly' 
            ? process.env.RAZORPAY_PLAN_ID 
            : process.env.RAZORPAY_PLAN_ID_YEARLY;
        
        logger.info('RAZORPAY_MAPPING', `Mapping: ${normalizedType} -> Account for: ${planId}`);
  
        if (!planId || planId === 'undefined' || planId === '') {
            logger.error('RAZORPAY_CONFIG_ERROR', `Plan ID for ${cycle} is not configured in .env`);
            return res.status(400).json({ 
                error: 'Configuration Error',
                message: `Subscription plan for ${cycle} is not configured on the server.`,
                code: 'PLAN_ID_MISSING'
            });
        }

        // 3. Ensure Razorpay Customer exists
        let customerId = user.razorpayCustomerId;
        if (!customerId) {
            try {
                const customer = await razorpay.customers.create({
                    name: user.username || 'CloraAI User',
                    email: user.email,
                    notes: { userId: user.id }
                });
                customerId = customer.id;
                
                // Save customer ID for next time
                await prisma.user.update({
                    where: { id: user.id },
                    data: { razorpayCustomerId: customerId }
                });
                
                logger.info('RAZORPAY_CUSTOMER_CREATED', `Customer ${customerId} created for user ${user.id}`);
            } catch (custErr) {
                logger.error('RAZORPAY_CUSTOMER_FAIL', custErr.message);
                // Continue if only it's a "customer already exists" type error, but usually better to fail or fetch.
            }
        }

        // 4. Create Subscription
        const subscription = await razorpay.subscriptions.create({
            plan_id: planId,
            total_count: cycle === 'MONTHLY' ? 120 : 10, 
            customer_notify: 1,
            customer_id: customerId, 
            notes: {
                userId: req.userId,
                billingCycle: cycle,
                environment: process.env.NODE_ENV || 'production'
            }
        });

        // 5. Update User Status to PENDING
        await prisma.user.update({
            where: { id: userId },
            data: { 
                razorpaySubscriptionId: subscription.id,
                billingCycle: normalizedType === 'monthly' ? 'MONTHLY' : 'YEARLY',
                subscriptionStatus: 'PENDING'
            }
        });

        logger.info('SUBSCRIPTION_CREATED', `Sub: ${subscription.id} for User: ${req.userId}`);
        
        return res.status(201).json({
            success: true,
            subscriptionId: subscription.id,
            plan_id: planId,
            amount: normalizedType === 'monthly' ? 299 : 2499,
            currency: 'INR',
            keyId: process.env.RAZORPAY_KEY_ID
        });

    } catch (error) {
        // Deep Debug: Unbox Razorpay SDK errors
        const errorMsg = error.description || error.response?.data?.error?.description || error.message;
        const errorCode = error.code || error.response?.data?.error?.code || 'SUBSCRIPTION_ERROR';
        const fullAudit = error.metadata || error.response?.data || error;
        
        logger.error('SUBSCRIPTION_CREATE_ERROR', 'Failed to create subscription', { 
            userId: req.userId,
            error: errorMsg,
            code: errorCode,
            details: fullAudit
        });
        
        return res.status(error.statusCode || 400).json({ 
            error: 'Failed to create subscription',
            message: errorMsg,
            code: errorCode,
            details: fullAudit
        });
    }
};

/**
 * 2. Verify Subscription API
 * POST /api/v1/subscription/verify
 * Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
 */
const verifySubscription = async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
        const userId = req.userId;

        // 1. Signature Verification
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const generated_signature = crypto
            .createHmac('sha256', secret)
            .update(razorpay_payment_id + '|' + razorpay_subscription_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            logger.warn('SUBSCRIPTION_VERIFY_FAILURE', 'Invalid subscription signature', { userId, subId: razorpay_subscription_id });
            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        // 2. Fetch User and Sync Plan Details
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.razorpaySubscriptionId !== razorpay_subscription_id) {
             return res.status(404).json({ error: 'Verification failed: Match mismatch.' });
        }

        const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);
        
        // 3. Update User Status
        const currentEnd = new Date(subscription.current_end * 1000);

        await prisma.user.update({
            where: { id: userId },
            data: {
                plan: 'PRO',
                subscriptionStatus: 'ACTIVE',
                planSource: 'RAZORPAY',
                planEndDate: currentEnd,
                currentPeriodEnd: currentEnd,
                paymentStatus: 'SUCCESS'
            }
        });

        // 4. Record Initial Payment (Wait for Webhook usually, but can record here for UX)
        await prisma.paymentHistory.create({
            data: {
                userId,
                razorpaySubscriptionId: razorpay_subscription_id,
                razorpayPaymentId: razorpay_payment_id,
                amount: subscription.plan_id === process.env.RAZORPAY_PLAN_MONTHLY ? 29900 : 249900,
                currency: 'INR',
                status: 'SUCCESS',
                planName: `PRO_${user.billingCycle}`,
                paymentMethod: 'RAZORPAY',
                processed: true
            }
        });

        await cache.clearUserCache(userId);
        logger.info('SUBSCRIPTION_VERIFIED', `User ${userId} active for ${razorpay_subscription_id}`);

        return res.status(200).json({
            success: true,
            message: 'Subscription activated successfully!',
            currentPeriodEnd: currentEnd
        });

    } catch (error) {
        logger.error('SUBSCRIPTION_VERIFY_ERROR', 'Verification failed', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

/**
 * 3. Cancel Subscription (at cycle end)
 * POST /api/v1/subscription/cancel
 */
const cancelSubscription = async (req, res) => {
    try {
        const userId = req.userId;
        const user = await prisma.user.findUnique({ where: { id: userId } });

        if (!user || !user.razorpaySubscriptionId) {
            return res.status(400).json({ error: 'No active subscription found' });
        }

        // Cancel at cycle end via Razorpay
        await razorpay.subscriptions.cancel(user.razorpaySubscriptionId, false); // second param is cancel_at_cycle_end

        await prisma.user.update({
            where: { id: userId },
            data: { subscriptionStatus: 'CANCELLED' }
        });

        logger.info('SUBSCRIPTION_CANCELLED', `User ${userId} cancelled ${user.razorpaySubscriptionId}`);
        return res.status(200).json({ success: true, message: 'Subscription cancelled at the end of the period.' });

    } catch (error) {
        logger.error('SUBSCRIPTION_CANCEL_ERROR', 'Cancellation failed', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

const FinancialService = require('../services/FinancialService');
const SubscriptionService = require('../services/subscriptionService');
const NotificationService = require('../services/notificationService');

/**
 * 4. Get Current Subscription Status
 * GET /api/v1/subscription/status
 */
const getStatus = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: {
                plan: true,
                subscriptionStatus: true,
                billingCycle: true,
                planEndDate: true,
                currentPeriodEnd: true
            }
        });

        if (!user) return res.status(404).json({ error: 'User not found' });

        return res.status(200).json({
            success: true,
            data: user
        });
    } catch (error) {
        logger.error('SUBSCRIPTION_STATUS_ERROR', 'Failed to get status', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

/**
 * 5. Get Payment History
 * GET /api/v1/subscription/history
 */
const getPaymentHistory = async (req, res) => {
    try {
        const history = await prisma.paymentHistory.findMany({
            where: { userId: req.userId },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({
            success: true,
            data: history
        });
    } catch (error) {
        logger.error('PAYMENT_HISTORY_ERROR', 'Failed to get history', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

/**
 * 5. Handle Razorpay Webhooks (Single Entry Point)
 * POST /api/v1/subscription/webhook
 * Handles 100% of subscription lifecycle events.
 */
const handleRazorpayWebhook = async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

    // 1. Signature Verification (Production Critical)
    const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');

    if (signature !== expectedSignature) {
        logger.warn('RAZORPAY_WEBHOOK_SEC', 'Invalid webhook signature received.');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    const { event, payload, account_id } = req.body;
    const eventId = req.body.id;

    // 2. Idempotency Check (Exactly-Once Processing)
    const existing = await prisma.webhookEvent.findUnique({ where: { eventId } });
    if (existing) return res.json({ success: true, message: 'Event already processed' });

    try {
        await prisma.webhookEvent.create({ data: { eventId, eventType: event } });

        const subObj = payload.subscription?.entity;
        const subId = subObj?.id;
        const userId = subObj?.notes?.userId;

        if (!userId) {
            logger.warn('RAZORPAY_WEBHOOK_WARN', `No userId in notes for event ${event}. Payload ignored.`);
            return res.json({ success: true });
        }

        switch (event) {
            case 'subscription.charged': {
                const currentEnd = new Date(subObj.current_end * 1000);
                const monthlyPlanId = process.env.RAZORPAY_PLAN_MONTHLY || process.env.RAZORPAY_PLAN_ID;
                const amount = subObj.plan_id === monthlyPlanId ? 29900 : 249900;

                // Update User Status
                await prisma.user.update({
                    where: { id: userId },
                    data: {
                        plan: 'PRO',
                        subscriptionStatus: 'ACTIVE',
                        planEndDate: currentEnd,
                        currentPeriodEnd: currentEnd,
                        paymentStatus: 'SUCCESS',
                        retryAttempts: 0
                    }
                });

                // Record Payment History
                const payment = await prisma.paymentHistory.create({
                    data: {
                        userId,
                        razorpaySubscriptionId: subId,
                        razorpayPaymentId: payload.payment?.entity?.id,
                        amount: amountPaise,
                        currency: 'INR',
                        status: 'SUCCESS',
                        planName: subObj.notes?.billingCycle === 'MONTHLY' ? 'PRO_MONTHLY' : 'PRO_YEARLY',
                        paymentMethod: payload.payment?.entity?.method || 'RAZORPAY',
                        processed: true
                    }
                });

                // Generate Invoice Snapshot
                const invNum = `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
                await prisma.invoice.create({
                    data: {
                        userId,
                        paymentHistoryId: payment.id,
                        invoiceNumber: invNum,
                        amount: amountPaise,
                        status: 'PAID'
                    }
                });

                // Notify User
                await NotificationService.notifyPaymentSuccess(userId, amountPaise / 100);
                logger.info('SUBSCRIPTION_CHARGED', `User ${userId} charged successfully for ${subId}`);
                break;
            }

            case 'subscription.halted': {
                await prisma.user.update({
                    where: { id: userId },
                    data: { subscriptionStatus: 'HALTED' }
                });
                await NotificationService.notifyHalted(userId);
                logger.warn('SUBSCRIPTION_HALTED', `User ${userId} subscription halted due to failure.`);
                break;
            }

            case 'subscription.cancelled': {
                await prisma.user.update({
                    where: { id: userId },
                    data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' }
                });
                logger.info('SUBSCRIPTION_CANCELLED', `User ${userId} sub ${subId} cancelled.`);
                break;
            }

            case 'payment.failed': {
                await prisma.user.update({
                    where: { id: userId },
                    data: { 
                        paymentStatus: 'FAILED',
                        retryAttempts: { increment: 1 } 
                    }
                });
                await NotificationService.notifyPaymentFailed(userId, 'PRO');
                logger.info('PAYMENT_FAILED', `User ${userId} payment failed for sub ${subId}`);
                break;
            }

            default:
                logger.info('RAZORPAY_WEBHOOK_INFO', `Unprocessed event: ${event}`);
        }

        await cache.clearUserCache(userId);
        res.json({ success: true });

    } catch (error) {
        logger.error('RAZORPAY_WEBHOOK_ERROR', `Failed processing ${event}: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    createSubscription,
    verifySubscription,
    cancelSubscription,
    getStatus,
    getPaymentHistory,
    handleRazorpayWebhook
};
