/**
 * routes/subscription.js
 * Subscription management routes for Recurring Billing.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const subscriptionController = require('../controllers/subscriptionController');
const { cacheRoute } = require('../utils/cache');
const validate = require('../middleware/validate');
const { createSubscriptionSchema } = require('../validators/subscription');

// 1. Create Razorpay Subscription (sub_xxx)
router.post('/create', 
    authenticate, 
    validate(createSubscriptionSchema), 
    subscriptionController.createSubscription
);

// 2. Verify Razorpay Subscription Signature
router.post('/verify', authenticate, subscriptionController.verifySubscription);

// 3. Get current subscription state (plan, status, billingCycle, currentPeriodEnd)
router.get('/status', authenticate, cacheRoute(3600, 'subscription'), subscriptionController.getStatus);

// 4. Get all payment transactions for the authenticated user
router.get('/history', authenticate, cacheRoute(3600, 'subscription'), subscriptionController.getPaymentHistory);

// 5. Mark subscription for cancellation (at cycle end)
router.post('/cancel', authenticate, subscriptionController.cancelSubscription);

module.exports = router;
