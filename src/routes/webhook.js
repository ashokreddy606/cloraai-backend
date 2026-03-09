/**
 * routes/webhook.js
 * Webhook routes — Meta (Instagram DM) + Razorpay subscription events.
 *
 * IMPORTANT: Razorpay webhook MUST use express.raw() for signature verification.
 * The raw body capture is registered in server.js BEFORE the global express.json().
 */
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const { handleRazorpayWebhook } = require('../controllers/razorpayWebhookController');

// ── Meta Instagram Webhook (Standard Paths) ───────────────────────────────────
// Verification handshake (GET)
router.get('/instagram', webhookController.verifyWebhook);
// Incoming DM events (POST)
router.post('/instagram', webhookController.handleWebhook);

// ── NEW: Root Meta Webhook (for direct /webhook access) ──────────────────────
router.get('/', webhookController.verifyWebhook);
router.post('/', webhookController.handleWebhook);

// ── Razorpay Subscription Webhook ─────────────────────────────────────────────
// Uses raw body captured in server.js for HMAC signature verification
// No JWT auth — secured via HMAC-SHA256 of raw payload
router.post('/razorpay', handleRazorpayWebhook);

module.exports = router;
