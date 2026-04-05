/**
 * routes/payment.js
 * Razorpay Payment Routes.
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createOrderSchema, verifyPaymentSchema } = require('../validators/subscription');
const { createOrder, verifyPayment } = require('../controllers/paymentController');

// 1. Create Razorpay Order
router.post('/create-order', authenticate, validate(createOrderSchema), createOrder);

// 2. Verify Payment Signature
router.post('/verify', authenticate, validate(verifyPaymentSchema), verifyPayment);

module.exports = router;
