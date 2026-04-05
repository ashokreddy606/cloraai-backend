/**
 * controllers/razorpayWebhookController.js
 * Handles asynchronous events from Razorpay Subscriptions (Idempotent).
 */

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { cache } = require('../utils/cache');

const handleRazorpayWebhook = async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    try {
        // 1. Signature Verification
        const shasum = crypto.createHmac('sha256', webhookSecret);
        shasum.update(JSON.stringify(req.body));
        const digest = shasum.digest('hex');

        if (digest !== signature) {
            logger.warn('RAZORPAY_WEBHOOK_SECURITY', 'Invalid webhook signature');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        const event = req.body;
        const eventId = event.id;

        // 2. Idempotency Check (Deduplication)
        const existingEvent = await prisma.webhookEvent.findUnique({
            where: { eventId }
        });

        if (existingEvent) {
            logger.info('RAZORPAY_WEBHOOK_SKIP', `Event ${eventId} already processed.`);
            return res.status(200).json({ status: 'ok', message: 'Already processed' });
        }

        // 3. Process Events
        logger.info('RAZORPAY_WEBHOOK_RECEIVED', `Processing event ${event.event}`, { eventId });

        const payload = event.payload;

        switch (event.event) {
            case 'subscription.activated':
            case 'subscription.authenticated': {
                const subscription = payload.subscription.entity;
                const userId = subscription.notes?.userId;
                if (!userId) break;

                await prisma.user.update({
                    where: { id: userId },
                    data: {
                        subscriptionStatus: 'ACTIVE',
                        razorpaySubscriptionId: subscription.id,
                        plan: 'PRO',
                        currentPeriodEnd: new Date(subscription.current_end * 1000)
                    }
                });
                break;
            }

            case 'invoice.paid': {
                const invoice = payload.invoice.entity;
                const subscription = payload.subscription ? payload.subscription.entity : null;
                const userId = invoice.notes?.userId || (subscription ? subscription.notes?.userId : null);

                if (userId) {
                    const currentEnd = new Date(invoice.billing_start * 1000); // Approximate if subscription entity missing
                    const nextEnd = subscription ? new Date(subscription.current_end * 1000) : null;

                    await prisma.$transaction([
                        prisma.user.update({
                            where: { id: userId },
                            data: {
                                plan: 'PRO',
                                subscriptionStatus: 'ACTIVE',
                                currentPeriodEnd: nextEnd || undefined
                            }
                        }),
                        prisma.paymentHistory.create({
                            data: {
                                userId,
                                razorpaySubscriptionId: invoice.subscription_id,
                                razorpayPaymentId: invoice.payment_id,
                                amount: invoice.amount,
                                currency: invoice.currency,
                                status: 'SUCCESS',
                                planName: 'PRO_RENEWAL',
                                paymentMethod: 'RAZORPAY_AUTO',
                                processed: true
                            }
                        })
                    ]);
                    await cache.clearUserCache(userId);
                }
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = payload.invoice.entity;
                const userId = invoice.notes?.userId;
                if (userId) {
                    await prisma.user.update({
                        where: { id: userId },
                        data: { subscriptionStatus: 'PAST_DUE' }
                    });
                    // Logic for 3-day grace period is handled by currentPeriodEnd checks in auth middleware or a worker
                    logger.warn('RAZORPAY_WEBHOOK_PAYMENT_FAILED', `Payment failed for user ${userId}`, { eventId });
                }
                break;
            }

            case 'subscription.cancelled':
            case 'subscription.expired': {
                const subscription = payload.subscription.entity;
                const userId = subscription.notes?.userId;
                if (userId) {
                    await prisma.user.update({
                        where: { id: userId },
                        data: {
                            plan: 'FREE',
                            subscriptionStatus: 'CANCELLED'
                        }
                    });
                    await cache.clearUserCache(userId);
                }
                break;
            }

            default:
                logger.info('RAZORPAY_WEBHOOK_UNHANDLED', `Event ${event.event} not explicitly handled.`);
        }

        // Store event ID to prevent duplicate processing
        await prisma.webhookEvent.create({
            data: {
                eventId,
                eventType: event.event
            }
        });

        return res.status(200).json({ status: 'ok' });

    } catch (error) {
        logger.error('RAZORPAY_WEBHOOK_ERROR', 'Failed to process webhook', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

module.exports = {
    handleRazorpayWebhook
};
