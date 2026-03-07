/**
 * routes/subscription.js
 * Razorpay subscription management routes.
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { createOrder, verifyPayment, getStatus, getPaymentHistory, cancelSubscription, renderCheckout } = require('../controllers/subscriptionController');

// Create a Razorpay subscription order → returns subscription_id to RN SDK
router.post('/create-order', authenticate, createOrder);

// Render a hosted checkout page for Expo Go fallback
router.get('/checkout/:subscriptionId', renderCheckout);

// Verify payment signature after user completes checkout → activates Pro plan
router.post('/verify', authenticate, verifyPayment);

// Get current subscription state (plan, status, daysRemaining, planSource)
router.get('/status', authenticate, getStatus);

// Get all payment transactions for the authenticated user
router.get('/history', authenticate, getPaymentHistory);

// Cancel the active Razorpay subscription gracefully (access kept until cycle end)
router.post('/cancel', authenticate, cancelSubscription);

module.exports = router;
