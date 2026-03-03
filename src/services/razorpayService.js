/**
 * razorpayService.js
 * Singleton Razorpay SDK wrapper for CloraAI.
 * All Razorpay API calls must go through this service — never construct
 * the SDK inline in controllers to avoid config drift.
 */

const Razorpay = require('razorpay');

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('[CRITICAL] RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing!');
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Create a Razorpay Subscription.
 * Call this when a user clicks "Upgrade to Pro" on the app.
 *
 * @param {string} planId - Razorpay Plan ID (e.g. plan_XXXXXXX) created in your dashboard
 * @param {number} totalCount - How many billing cycles (12 = 1 year, 1 = one-shot)
 * @param {object} notes - Optional key-value notes to tag the subscription
 * @returns Razorpay Subscription object
 */
const createSubscription = async (planId, totalCount = 12, notes = {}) => {
    return razorpay.subscriptions.create({
        plan_id: planId,
        total_count: totalCount,
        quantity: 1,
        notes,
    });
};

/**
 * Cancel a Razorpay Subscription immediately.
 * @param {string} subscriptionId - Razorpay sub_xxx id
 * @param {boolean} cancelAtCycleEnd - If true, cancels at current billing cycle end (graceful)
 */
const cancelSubscription = async (subscriptionId, cancelAtCycleEnd = false) => {
    return razorpay.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
};

/**
 * Fetch a Razorpay Subscription's current state from Razorpay servers.
 * @param {string} subscriptionId - Razorpay sub_xxx id
 */
const fetchSubscription = async (subscriptionId) => {
    return razorpay.subscriptions.fetch(subscriptionId);
};

/**
 * Issue a full or partial refund on a Razorpay payment.
 * @param {string} paymentId - Razorpay pay_xxx id
 * @param {number|null} amount - Amount in paise to refund. null = full refund.
 * @param {string} reason - Reason for refund (customer_request | duplicate | fraud)
 */
const createRefund = async (paymentId, amount = null, reason = 'customer_request') => {
    const body = { speed: 'optimum', notes: { reason } };
    if (amount) body.amount = amount; // partial refund
    return razorpay.payments.refund(paymentId, body);
};

/**
 * Fetch a payment's details.
 * @param {string} paymentId
 */
const fetchPayment = async (paymentId) => {
    return razorpay.payments.fetch(paymentId);
};

module.exports = {
    razorpay,
    createSubscription,
    cancelSubscription,
    fetchSubscription,
    createRefund,
    fetchPayment,
};
