const crypto = require('crypto');
const Razorpay = require('razorpay');
const prisma = require('../lib/prisma');
const { calculateProratedExpiry } = require('../services/subscriptionService');
const { notifyPaymentSuccess, notifyPaymentFailed } = require('../services/emailService');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * PRODUCTION-READY PAYMENT CONTROLLER
 */

// ─── 1. CREATE PAYMENT ORDER ───────────────────────────────────────────
const createOrder = async (req, res) => {
    try {
        const { planId, promoCode } = req.body;
        const userId = req.userId;

        // 1. Fetch plan from database
        const plan = await prisma.planConfig.findUnique({
            where: { planId }
        });

        if (!plan || !plan.active) {
            return res.status(404).json({ error: 'Invalid or inactive plan' });
        }

        // 2. Calculate initial price (plan discount handled in DB)
        let finalAmount = plan.price * (1 - plan.discountPercent / 100);

        // 3. Apply promo code if exists
        if (promoCode) {
            const promo = await prisma.promoCode.findUnique({
                where: { code: promoCode }
            });

            if (promo && promo.active && promo.usedCount < promo.maxUses && new Date(promo.expiryDate) > new Date()) {
                finalAmount = finalAmount * (1 - promo.discountPercent / 100);
            } else {
                return res.status(400).json({ error: 'Invalid or expired promo code' });
            }
        }

        // 4. Create Razorpay order (amount in paise)
        const options = {
            amount: Math.round(finalAmount * 100),
            currency: 'INR',
            receipt: `receipt_${userId}_${Date.now()}`,
            notes: {
                userId,
                planId,
                promoCode: promoCode || null
            }
        };

        const order = await razorpay.orders.create(options);

        // 5. Log initial payment history
        await prisma.paymentHistory.create({
            data: {
                userId,
                razorpayOrderId: order.id,
                amount: options.amount,
                status: 'PENDING',
                planName: plan.name
            }
        });

        res.json({
            success: true,
            data: {
                orderId: order.id,
                amount: order.amount,
                keyId: process.env.RAZORPAY_KEY_ID
            }
        });
    } catch (error) {
        console.error('[Payment] Create Order Error:', error);
        res.status(500).json({ error: 'Failed to create payment order' });
    }
};

// ─── 2. VERIFY PAYMENT ───────────────────────────────────────────────
const verifyPayment = async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
        const userId = req.userId;

        // 1. Verify Signature
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, error: 'Invalid payment signature' });
        }

        // 2. Get Order Details from PaymentHistory to find the plan
        const payment = await prisma.paymentHistory.findFirst({
            where: { razorpayOrderId: razorpay_order_id }
        });

        if (!payment) return res.status(404).json({ error: 'Payment record not found' });

        // 4. Calculate Prorated Expiry
        const duration = planConfig ? planConfig.durationDays : 30;
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const expiryDate = calculateProratedExpiry(user, duration);

        // 5. Update Payment History & User Plan
        await prisma.$transaction([
            prisma.paymentHistory.update({
                where: { id: payment.id },
                data: {
                    status: 'SUCCESS',
                    razorpayPaymentId: razorpay_payment_id,
                    processed: true // Idempotency
                }
            }),
            prisma.user.update({
                where: { id: userId },
                data: {
                    plan: 'PRO',
                    subscriptionStatus: 'ACTIVE',
                    planEndDate: expiryDate,
                    planSource: 'RAZORPAY',
                    paymentStatus: 'SUCCESS',
                    retryAttempts: 0
                }
            })
        ]);

        // 6. Update Promo usage count if applicable
        if (orderDetails.notes.promoCode) {
            await prisma.promoCode.update({
                where: { code: orderDetails.notes.promoCode },
                data: { usedCount: { increment: 1 } }
            });
        }

        // 7. Send Email Notification
        await notifyPaymentSuccess(user, planConfig ? planConfig.name : 'PRO');

        res.json({ success: true, message: 'Subscription activated. Check your email for confirmation! 🎉' });
    } catch (error) {
        console.error('[Payment] Verify Error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
};

// ─── 3. WEBHOOK HANDLER ──────────────────────────────────────────────
const handleWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

    if (expectedSignature !== signature) {
        return res.status(400).send('Invalid signature');
    }

    const { event, payload } = req.body;

    try {
        if (event === 'payment.captured' || event === 'order.paid') {
            const orderId = payload.payment.entity.order_id;

            const payment = await prisma.paymentHistory.findFirst({
                where: { razorpayOrderId: orderId }
            });

            // IDEMPOTENCY CHECK
            if (payment && !payment.processed) {
                const user = await prisma.user.findUnique({ where: { id: payment.userId } });

                // Fetch plan to get duration
                const orderDetails = await razorpay.orders.fetch(orderId);
                const planId = orderDetails.notes.planId;
                const planConfig = await prisma.planConfig.findUnique({ where: { planId } });
                const duration = planConfig ? planConfig.durationDays : 30;

                const expiryDate = calculateProratedExpiry(user, duration);

                await prisma.$transaction([
                    prisma.user.update({
                        where: { id: payment.userId },
                        data: {
                            subscriptionStatus: 'ACTIVE',
                            plan: 'PRO',
                            planEndDate: expiryDate,
                            paymentStatus: 'SUCCESS',
                            retryAttempts: 0
                        }
                    }),
                    prisma.paymentHistory.update({
                        where: { id: payment.id },
                        data: {
                            status: 'SUCCESS',
                            processed: true
                        }
                    })
                ]);

                await notifyPaymentSuccess(user, planConfig ? planConfig.name : 'PRO');
            }
        }
        else if (event === 'payment.failed' || event === 'invoice.payment_failed') {
            const orderId = payload.payment ? payload.payment.entity.order_id : null;
            if (orderId) {
                const payment = await prisma.paymentHistory.findFirst({
                    where: { razorpayOrderId: orderId }
                });

                if (payment) {
                    const user = await prisma.user.findUnique({ where: { id: payment.userId } });
                    await prisma.user.update({
                        where: { id: payment.userId },
                        data: {
                            paymentStatus: 'FAILED',
                            retryAttempts: { increment: 1 }
                        }
                    });

                    await prisma.paymentHistory.update({
                        where: { id: payment.id },
                        data: { status: 'FAILED' }
                    });

                    await notifyPaymentFailed(user, payment.planName);
                }
            }
        }
        else if (event === 'refund.processed') {
            const { payment_id, amount } = payload.refund.entity;
            const refundAmount = amount; // In paise

            const payment = await prisma.paymentHistory.findFirst({
                where: { razorpayPaymentId: payment_id }
            });

            if (payment) {
                const user = await prisma.user.findUnique({ where: { id: payment.userId } });

                if (user) {
                    // Update Payment History
                    const updatedRefundedAmount = (payment.refundedAmount || 0) + refundAmount;
                    await prisma.paymentHistory.update({
                        where: { id: payment.id },
                        data: {
                            status: updatedRefundedAmount >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
                            refundedAmount: updatedRefundedAmount
                        }
                    });

                    // Logic for Full Refund
                    if (updatedRefundedAmount >= payment.amount) {
                        await prisma.user.update({
                            where: { id: user.id },
                            data: {
                                plan: 'FREE',
                                subscriptionStatus: 'EXPIRED',
                                planStartDate: null,
                                planEndDate: null
                            }
                        });
                        console.log(`[Refund] Full refund processed for user ${user.id}. Account downgraded to FREE.`);
                    }
                    // Logic for Partial Refund
                    else {
                        const refundRatio = refundAmount / payment.amount;
                        if (user.planEndDate) {
                            const now = new Date();
                            const currentEnd = new Date(user.planEndDate);
                            const remainingTime = currentEnd.getTime() - now.getTime();

                            if (remainingTime > 0) {
                                const deduction = remainingTime * refundRatio;
                                const newEndDate = new Date(currentEnd.getTime() - deduction);

                                await prisma.user.update({
                                    where: { id: user.id },
                                    data: { planEndDate: newEndDate }
                                });
                                console.log(`[Refund] Partial refund for user ${user.id}. Duration reduced.`);
                            }
                        }
                    }
                }
            }
        }

        res.json({ status: 'ok' });
    } catch (error) {
        console.error('[Payment] Webhook Error:', error);
        res.status(500).send('Internal Server Error');
    }
};

// ─── 4. PAYMENT HISTORY ───────────────────────────────────────────────
const getUserPaymentHistory = async (req, res) => {
    try {
        const history = await prisma.paymentHistory.findMany({
            where: { userId: req.userId },
            orderBy: { createdAt: 'desc' },
            select: {
                planName: true,
                amount: true,
                status: true,
                createdAt: true,
                razorpayPaymentId: true,
                razorpayOrderId: true
            }
        });
        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
};

module.exports = {
    createOrder,
    verifyPayment,
    handleWebhook,
    getUserPaymentHistory
};
