/**
 * config/razorpay.js
 * Razorpay instance initialization.
 */
const Razorpay = require('razorpay');

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('[Razorpay] Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in environment variables.');
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret',
});

// Live Mode Detection
const isLive = process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_');
if (isLive) {
    console.log('\x1b[32m%s\x1b[0m', '[Razorpay] LIVE MODE ACTIVE: Using production credentials.');
} else {
    console.log('\x1b[33m%s\x1b[0m', '[Razorpay] TEST MODE: Using sandbox/test credentials.');
}

// Verification Check
if (isLive && (!process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET === 'CHANGE_ME')) {
    console.warn('\x1b[31m%s\x1b[0m', '[Razorpay] WARNING: Live mode active but RAZORPAY_WEBHOOK_SECRET is NOT set. Webhooks will fail verification!');
}

module.exports = razorpay;
