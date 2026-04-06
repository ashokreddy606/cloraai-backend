/**
 * validators/subscription.js — Zod schemas for subscription routes
 */
const { z } = require('zod');

// Razorpay schemas will be added here
const createOrderSchema = z.object({
    body: z.object({
        amount: z.number().positive(),
        plan: z.enum(['PRO', 'PREMIUM']),
    }),
});

const verifyPaymentSchema = z.object({
    body: z.object({
        razorpay_order_id: z.string().min(1),
        razorpay_payment_id: z.string().min(1),
        razorpay_signature: z.string().min(1),
    }),
});

const createSubscriptionSchema = z.object({
    body: z.object({
        type: z.enum([
            'monthly', 'yearly', 
            'MONTHLY', 'YEARLY', 
            'Monthly', 'Yearly'
        ]),
    }),
});

module.exports = { createOrderSchema, verifyPaymentSchema, createSubscriptionSchema };
