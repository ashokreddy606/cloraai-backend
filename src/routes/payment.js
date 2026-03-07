const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticate } = require('../middleware/auth');

/**
 * PRODUCTION PAYMENT ROUTES
 */

// User-facing endpoints
router.post('/create-order', authenticate, paymentController.createOrder);
router.post('/verify', authenticate, paymentController.verifyPayment);
router.get('/history', authenticate, paymentController.getUserPaymentHistory);

// Webhook endpoint (Requires body-parsing logic handled in server.js)
router.post('/webhook', express.raw({ type: 'application/json' }), paymentController.handleWebhook);

module.exports = router;
