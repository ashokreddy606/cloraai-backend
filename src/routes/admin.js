const express = require('express');
const router = express.Router();
const admin = require('../controllers/adminController');
const adminAnalytics = require('../controllers/adminAnalyticsController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// All routes require auth + admin role
router.use(authenticate, requireAdmin);

// ── Overview ──────────────────────────────────────────────────────────
router.get('/metrics', admin.getMetrics);
router.get('/system-metrics', admin.getSystemMetrics); // Phase 3: AI cost + subscription health
router.get('/analytics', admin.getAnalytics);

// ── Billing & Analytics (Stripe-Style) ────────────────────────────────
router.get('/billing-dashboard', adminAnalytics.getBillingDashboard);
router.get('/revenue-chart', adminAnalytics.getRevenueChart);
router.get('/subscriber-growth', adminAnalytics.getSubscriberGrowth);
router.get('/plan-distribution', adminAnalytics.getPlanDistribution);
router.get('/top-customers', adminAnalytics.getTopCustomers);
router.get('/recent-transactions', adminAnalytics.getRecentTransactions);

// ── User Management ───────────────────────────────────────────────────
router.get('/users', admin.getUsers);
router.get('/users/:id', admin.getUserDetail);
router.delete('/users/:id', admin.deleteUser);
router.post('/users/:id/reset-password', admin.resetUserPassword);
router.patch('/users/:id/suspend', admin.suspendUser);
router.patch('/users/:id/ban', admin.banUser);

// ── Subscription Admin (Full Control) ────────────────────────────────
router.post('/users/:userId/upgrade-pro', admin.adminUpgradeToPro);        // Upgrade → PRO (N days)
router.post('/users/:userId/downgrade-free', admin.adminDowngradeToFree);  // Downgrade → FREE immediately
router.post('/users/:userId/grant-lifetime', admin.adminGrantLifetime);    // Grant LIFETIME (never expires)
router.post('/users/:userId/extend-subscription', admin.adminExtendSubscription); // Extend N days
router.post('/users/:userId/cancel-subscription', admin.adminCancelSubscription); // Cancel (+ optional Razorpay)
router.get('/users/:userId/subscription-history', admin.getSubscriptionHistory);  // Payment history

// ── Payments ──────────────────────────────────────────────────────────
router.post('/payments/:paymentId/refund', admin.adminRefundPayment);      // Refund via Razorpay API

// ── Subscriptions Overview ────────────────────────────────────────────
router.get('/subscriptions', admin.getSubscriptions);
router.get('/payments', admin.getAllPayments);


// ── Scheduled Posts ───────────────────────────────────────────────────
router.get('/scheduled-posts', admin.getScheduledPosts);
router.delete('/scheduled-posts/:id', admin.deleteScheduledPost);
router.post('/scheduled-posts/pause-global', admin.pauseSchedulingGlobally);
router.post('/scheduled-posts/:id/retry', admin.retryFailedPost);

// ── Caption Moderation ────────────────────────────────────────────────
router.get('/captions', admin.getCaptions);
router.delete('/captions/:id', admin.deleteCaption);

// ── DM Automation ─────────────────────────────────────────────────────
router.get('/dm-automations', admin.getDMAutomations);
router.post('/dm-automations/stop-all', admin.stopAllAutomations);
router.delete('/dm-automations/:id', admin.deleteDMAutomation);

// ── Brand Deals ───────────────────────────────────────────────────────
router.get('/brand-deals', admin.getBrandDeals);
router.post('/brand-deals', admin.createBrandDeal);
router.patch('/brand-deals/:id', admin.updateBrandDeal);
router.delete('/brand-deals/:id', admin.deleteBrandDeal);
router.patch('/brand-deals/:id/mark-scam', admin.markDealAsScam);
router.get('/brand-deals/:id/replies', admin.getDealReplies);
router.post('/brand-deals/:id/shortlist', admin.aiShortlistReplies);
router.post('/brand-deals/:id/replies/:replyId/shortlist', admin.manualShortlist);
router.post('/brand-deals/:id/send-notifications', admin.sendDealNotifications);

// ── Notifications ─────────────────────────────────────────────────────
router.post('/broadcast', admin.broadcastNotification);

// ── App Config ────────────────────────────────────────────────────────
router.get('/config', admin.getAppConfig);
router.patch('/config', admin.updateAppConfig);

// ── AI Feature Control ────────────────────────────────────────────────
router.get('/ai-config', admin.getAIConfig);
router.patch('/ai-config', admin.updateAIConfig);
router.post('/ai-config/block/:userId', admin.blockUserFromAI);
router.post('/ai-config/unblock/:userId', admin.unblockUserFromAI);

// ── Security Panel ────────────────────────────────────────────────────
router.get('/security', admin.getSecurityLogs);
router.post('/security/blacklist', admin.blacklistIP);
router.delete('/security/blacklist/:ip', admin.removeIPFromBlacklist);

// ── Referral Management ───────────────────────────────────────────────
const adminReferral = require('../controllers/adminReferralController');
router.get('/referrals/overview', adminReferral.getOverview);
router.get('/referrals/top-referrers', adminReferral.getTopReferrers);
router.get('/referrals/fraud-alerts', adminReferral.getFraudAlerts);
router.post('/referrals/adjust-credits', adminReferral.adjustCredits);

// ── Audit Logs ────────────────────────────────────────────────────────
router.get('/audit-logs', admin.getAuditLogs);

module.exports = router;
