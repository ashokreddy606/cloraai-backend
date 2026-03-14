/**
 * routes/subscription.js
 * Razorpay subscription management routes.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { verifyGooglePlayPurchase, getStatus, getPaymentHistory, cancelSubscription } = require('../controllers/subscriptionController');
const { cacheRoute } = require('../utils/cache');

// Verify Google Play Billing purchase
router.post('/verify-google-play', authenticate, verifyGooglePlayPurchase);

// Get current subscription state (plan, status, daysRemaining, planSource)
router.get('/status', authenticate, cacheRoute(3600, 'subscription'), getStatus);

// Get all payment transactions for the authenticated user
router.get('/history', authenticate, cacheRoute(3600, 'subscription'), getPaymentHistory);

// Mark subscription for cancellation (Note: actual management is via Google Play Store)
router.post('/cancel', authenticate, cancelSubscription);

module.exports = router;
