const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * PRODUCTION PAYMENT ROUTES
 */

// User-facing endpoints
router.post('/create-order', authMiddleware, paymentController.createOrder);
router.post('/verify', authMiddleware, paymentController.verifyPayment);
router.get('/history', authMiddleware, paymentController.getUserPaymentHistory);

// Webhook endpoint (Requires body-parsing logic handled in server.js)
router.post('/webhook', express.raw({ type: 'application/json' }), paymentController.handleWebhook);

module.exports = router;
