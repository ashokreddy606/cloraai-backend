/**
 * controllers/paymentController.js
 * Production-ready Razorpay payment integration.
 */

const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { cache } = require('../utils/cache');

/**
 * 1. Create Order API
 * POST /api/payment/create-order
 * Body: { amount, plan }
 */
const createOrder = async (req, res) => {
    try {
        const { amount, plan } = req.body;
        const userId = req.userId;

        if (!amount || !plan) {
            return res.status(400).json({ error: 'Amount and plan are required' });
        }

        // 1. Create Razorpay Order
        const options = {
            amount: Math.round(amount * 100), // convert to paise
            currency: 'INR',
            receipt: `receipt_user_${userId}_${Date.now()}`,
            notes: {
                userId,
                plan,
            }
        };

        const order = await razorpay.orders.create(options);

        // 2. Save Order in DB
        await prisma.paymentHistory.create({
            data: {
                userId,
                razorpayOrderId: order.id,
                amount: order.amount,
                currency: order.currency,
                status: 'CREATED',
                planName: plan,
                paymentMethod: 'RAZORPAY',
            }
        });

        logger.info('PAYMENT_ORDER_CREATED', `Order ${order.id} created for user ${userId}`, { orderId: order.id });

        return res.status(201).json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID
        });

    } catch (error) {
        logger.error('PAYMENT_ORDER_ERROR', 'Failed to create Razorpay order', { error: error.message });
        return res.status(500).json({ error: 'Failed to create payment order' });
    }
};

/**
 * 2. Verify Payment API
 * POST /api/payment/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.userId;

        // 1. Signature Verification
        const secret = process.env.RAZORPAY_KEY_SECRET;
        const generated_signature = crypto
            .createHmac('sha256', secret)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            logger.warn('PAYMENT_VERIFY_FAILURE', 'Invalid payment signature', { userId, orderId: razorpay_order_id });
            
            // Mark as FAILED in DB if order found
            await prisma.paymentHistory.updateMany({
                where: { razorpayOrderId: razorpay_order_id },
                data: { status: 'FAILED' }
            });

            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        // 2. Fetch Payment Record and Update
        const paymentRecord = await prisma.paymentHistory.findFirst({
            where: { razorpayOrderId: razorpay_order_id }
        });

        if (!paymentRecord) {
            return res.status(404).json({ error: 'Payment record not found' });
        }

        // 3. Update User Plan (Atomic Transaction)
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30); // Standard 30 days

        await prisma.$transaction([
            prisma.paymentHistory.update({
                where: { id: paymentRecord.id },
                data: {
                    status: 'SUCCESS',
                    razorpayPaymentId: razorpay_payment_id,
                    processed: true
                }
            }),
            prisma.user.update({
                where: { id: userId },
                data: {
                    plan: paymentRecord.planName,
                    subscriptionStatus: 'ACTIVE',
                    planSource: 'RAZORPAY',
                    planStartDate: new Date(),
                    planEndDate: expiryDate,
                    paymentStatus: 'SUCCESS'
                }
            })
        ]);

        // 4. Clear User Cache
        await cache.clearUserCache(userId);

        logger.info('PAYMENT_SUCCESS', `Payment verified for user ${userId}`, { userId, orderId: razorpay_order_id });

        return res.status(200).json({
            success: true,
            message: 'Payment verified and plan activated',
            plan: paymentRecord.planName,
            expiryDate
        });

    } catch (error) {
        logger.error('PAYMENT_VERIFY_ERROR', 'Verification failed', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

module.exports = {
    createOrder,
    verifyPayment
};
