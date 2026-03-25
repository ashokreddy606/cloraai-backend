const prisma = require('../lib/prisma');
const { hashPassword } = require('../utils/helpers');
const { appConfig, saveConfig } = require('../config');
// Razorpay imports removed
const logger = require('../utils/logger');
const OpenAI = require('openai');
const { logAIUsage } = require('../middleware/aiLimiter');
const pushNotificationService = require('../services/pushNotificationService');


const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Store for IP blacklist (in-memory — not plan-change-critical)
let ipBlacklist = [];

// ─── DB-Backed Audit Log Helper ─────────────────────────────────────────────────
// Replaces the old in-memory adminActionLogs array.
// Persists every admin plan override to AuditLog table for compliance.
const createAuditLog = async (adminId, targetId, action, details = null) => {
    try {
        await prisma.auditLog.create({
            data: {
                adminId,
                targetId: targetId || 'system',
                action,
                details: details ? JSON.stringify(details) : null,
            },
        });
        logger.info('AUDIT', `Admin ${adminId} → ${action} on ${targetId}`);
    } catch (e) {
        // Never crash the request over a logging failure
        logger.warn('AUDIT', `Failed to write audit log for action ${action}: ${e.message}`);
    }
};

// Legacy shim — keeps non-subscription log calls working without changes
const logAdminAction = (adminId, action, target = null) => {
    // Fire-and-forget DB write for non-critical actions
    createAuditLog(adminId, target, action).catch(() => { });
};


// ─── 1. OVERVIEW METRICS ───────────────────────────────────────────────
const getMetrics = async (req, res) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [
            totalUsers, paidUsers, connectedIG, totalCaptions, captionsToday,
            dmRules, scheduledPosts, scheduledToday, failedPosts, brandDeals,
        ] = await Promise.all([
            prisma.user.count(),
            // Count users on PRO or LIFETIME plan with ACTIVE status
            prisma.user.count({ where: { plan: { not: 'FREE' }, subscriptionStatus: 'ACTIVE' } }),
            prisma.instagramAccount.count({ where: { isConnected: true } }),
            prisma.caption.count(),
            prisma.caption.count({ where: { createdAt: { gte: startOfDay } } }),
            prisma.dMAutomation.count({ where: { isActive: true } }),
            prisma.scheduledPost.count(),
            prisma.scheduledPost.count({ where: { createdAt: { gte: startOfDay } } }),
            prisma.scheduledPost.count({ where: { status: 'failed' } }),
            prisma.brandDeal.count().catch(() => 0),
        ]);

        const newUsersToday = await prisma.user.count({ where: { createdAt: { gte: startOfDay } } });
        const newUsersThisMonth = await prisma.user.count({ where: { createdAt: { gte: startOfMonth } } });

        // Real revenue from PaymentHistory SUCCESS records
        const revenueResult = await prisma.paymentHistory.aggregate({
            _sum: { amount: true },
            where: { status: 'SUCCESS' },
        });
        const totalRevenuePaise = revenueResult._sum.amount || 0;
        const revenueToday = 0;
        const revenueMonth = paidUsers * 199;
        const totalRevenue = Math.round(totalRevenuePaise / 100); // paise → rupees

        res.json({
            success: true,
            data: {
                totalUsers,
                activeUsers: newUsersToday,
                paidUsers,
                freeUsers: totalUsers - paidUsers,
                connectedAccounts: connectedIG,
                captionsGenerated: totalCaptions,
                captionsToday,
                dmRulesActive: dmRules,
                scheduledPosts,
                scheduledToday,
                failedPosts,
                brandDealsDetected: brandDeals,
                newUsersToday,
                newUsersThisMonth,
                revenueToday,
                revenueMonth,
                totalRevenue,
                maintenanceMode: appConfig.maintenanceMode,
                featureFlags: appConfig.featureFlags,
            },
        });
    } catch (error) {
        console.error('Admin metrics error:', error);
        res.status(500).json({ error: 'Failed to fetch metrics', message: error.message });
    }
};

// ─── 2. USER MANAGEMENT ────────────────────────────────────────────────
const getUsers = async (req, res) => {
    try {
        const { search, plan, status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where = {};
        if (search) {
            where.OR = [
                { email: { contains: search } },
                { username: { contains: search } },
            ];
        }
        if (status === 'suspended') where.role = 'SUSPENDED';
        if (status === 'banned') where.role = 'BANNED';
        // Filter by plan using new User.plan field
        if (plan === 'pro') where.plan = 'PRO';
        if (plan === 'lifetime') where.plan = 'LIFETIME';
        if (plan === 'free') where.plan = 'FREE';

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                include: {
                    // subscription relation removed — use plan fields on User instead
                    instagramAccounts: { select: { username: true, isConnected: true } },
                    _count: { select: { captions: true, scheduledPosts: true, calendarTasks: true, dmAutomations: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.user.count({ where }),
        ]);

        // Remove passwords
        const result = users.map(u => { const { password, ...rest } = u; return rest; });

        res.json({ success: true, data: { users: result, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users', message: error.message });
    }
};

const getUserDetail = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            include: {
                // subscription relation removed — plan info lives on User model now
                paymentHistory: { take: 10, orderBy: { createdAt: 'desc' } },
                instagramAccounts: true,
                captions: { take: 10, orderBy: { createdAt: 'desc' } },
                scheduledPosts: { take: 10, orderBy: { createdAt: 'desc' } },
                dmAutomations: { take: 10 },
                _count: { select: { captions: true, scheduledPosts: true, calendarTasks: true, dmAutomations: true } },
            },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const { password, ...rest } = user;
        res.json({ success: true, data: { user: rest } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user', message: error.message });
    }
};

const deleteUser = async (req, res) => {
    try {
        const { id } = req.params;
        if (id === req.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
        await prisma.user.delete({ where: { id } });
        logAdminAction(req.userId, 'DELETE_USER', id);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete user', message: error.message });
    }
};

const resetUserPassword = async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        const hashed = await hashPassword(newPassword);
        await prisma.user.update({ where: { id: req.params.id }, data: { password: hashed } });
        logAdminAction(req.userId, 'RESET_PASSWORD', req.params.id);
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reset password', message: error.message });
    }
};

const suspendUser = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const newRole = user.role === 'SUSPENDED' ? 'USER' : 'SUSPENDED';
        await prisma.user.update({ where: { id: req.params.id }, data: { role: newRole } });
        logAdminAction(req.userId, newRole === 'SUSPENDED' ? 'SUSPEND_USER' : 'REACTIVATE_USER', req.params.id);
        res.json({ success: true, message: newRole === 'SUSPENDED' ? 'User suspended' : 'User reactivated', role: newRole });
    } catch (error) {
        res.status(500).json({ error: 'Failed to suspend user', message: error.message });
    }
};

const banUser = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const newRole = user.role === 'BANNED' ? 'USER' : 'BANNED';
        await prisma.user.update({ where: { id: req.params.id }, data: { role: newRole } });
        logAdminAction(req.userId, newRole === 'BANNED' ? 'BAN_USER' : 'UNBAN_USER', req.params.id);
        res.json({ success: true, message: newRole === 'BANNED' ? 'User banned' : 'User unbanned', role: newRole });
    } catch (error) {
        res.status(500).json({ error: 'Failed to ban user', message: error.message });
    }
};

// ─── 3. SUBSCRIPTION MANAGEMENT (Razorpay-native) ─────────────────────

/**
 * Admin upgrade user to PRO.
 * Overrides Razorpay — manuallyUpgraded=true prevents cron from downgrading.
 * Also creates a PaymentHistory record so the grant appears in Transaction History.
 */
const adminUpgradeToPro = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const { days = 30 } = req.body;
        const now = new Date();
        const planEndDate = new Date(now.getTime() + days * 86400000);

        // Determine plan label from days
        const planLabel =
            days >= 36000 ? 'PRO — Lifetime (Admin)' :
                days >= 360 ? 'PRO — Yearly (Admin)' :
                    days >= 85 ? 'PRO — Quarterly (Admin)' :
                        'PRO — Monthly (Admin)';

        // Run user update + PaymentHistory creation in a transaction
        const [user] = await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: {
                    plan: 'PRO',
                    subscriptionStatus: 'ACTIVE',
                    planSource: 'ADMIN',
                    planStartDate: now,
                    planEndDate,
                    manuallyUpgraded: true,
                    // FIX: Null out any stale Razorpay subscription link.
                    // This prevents a lingering Razorpay webhook from overriding
                    // this admin grant when the next billing cycle fires.
                    activeRazorpaySubscriptionId: null,
                },
                select: { id: true, email: true, plan: true, subscriptionStatus: true, planEndDate: true },
            }),
            prisma.paymentHistory.create({
                data: {
                    userId,
                    amount: 0,            // Admin grant — no charge
                    currency: 'INR',
                    status: 'SUCCESS',
                    planName: planLabel,
                    paymentMethod: 'ADMIN_GRANT',
                    startDate: now,
                    endDate: planEndDate,
                    transactionId: `admin_grant_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                },
            }),
        ]);

        await createAuditLog(req.userId, userId, 'UPGRADE_PRO', {
            before: { plan: 'FREE' },
            after: { plan: 'PRO', planEndDate, days },
        });
        res.json({ success: true, message: `User upgraded to PRO for ${days} day(s)`, data: { user } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to upgrade user', message: error.message });
    }
};

/**
 * Admin downgrade user to FREE immediately.
 */
const adminDowngradeToFree = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        // FIX: Read the active sub ID directly from User, NOT from PaymentHistory.
        // PaymentHistory-based lookup fails when the last SUCCESS record is an admin
        // grant (razorpaySubscriptionId = null), causing the wrong sub to be cancelled
        // (or none at all), leaving the Razorpay subscription active and re-upgrading
        // the user on the next billing cycle.
        const userRecord = await prisma.user.findUnique({
            where: { id: userId },
            select: { activeRazorpaySubscriptionId: true },
        });

        if (userRecord?.activeRazorpaySubscriptionId) {
            console.log(`[Admin] Native subscription reference ${userRecord.activeRazorpaySubscriptionId} found for user ${userId}. (Manual downgrade — no API call made)`);
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: {
                plan: 'FREE',
                subscriptionStatus: 'EXPIRED',
                planEndDate: new Date(),
                manuallyUpgraded: false,
                // FIX: Null out the Razorpay sub link. This is the key guard —
                // the webhook handler checks this field and skips re-upgrade if null.
                activeRazorpaySubscriptionId: null,
            },
            select: { id: true, email: true, plan: true, subscriptionStatus: true },
        });
        await createAuditLog(req.userId, userId, 'DOWNGRADE_FREE', {
            before: { plan: 'PRO' },
            after: { plan: 'FREE', reason: 'Admin manual downgrade' },
        });
        res.json({ success: true, message: 'User downgraded to FREE and Razorpay subscription cancelled', data: { user } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to downgrade user', message: error.message });
    }
};

/**
 * Grant LIFETIME plan — never expires.
 */
const adminGrantLifetime = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const user = await prisma.user.update({
            where: { id: userId },
            data: {
                plan: 'LIFETIME',
                subscriptionStatus: 'ACTIVE',
                planSource: 'ADMIN',
                planStartDate: new Date(),
                planEndDate: null, // null = never expires
                manuallyUpgraded: true,
            },
            select: { id: true, email: true, plan: true, subscriptionStatus: true },
        });
        await createAuditLog(req.userId, userId, 'GRANT_LIFETIME', {
            after: { plan: 'LIFETIME', planEndDate: null },
        });
        res.json({ success: true, message: 'Lifetime plan granted 🎉', data: { user } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to grant Lifetime plan', message: error.message });
    }
};

/**
 * Extend an existing PRO subscription by N days.
 */
const adminExtendSubscription = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const { days = 30 } = req.body;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { plan: true, planEndDate: true },
        });

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.plan === 'LIFETIME') {
            return res.status(400).json({ error: 'Cannot extend a Lifetime plan' });
        }

        // Extend from current planEndDate or from today (whichever is later)
        const base = user.planEndDate && new Date(user.planEndDate) > new Date()
            ? new Date(user.planEndDate)
            : new Date();
        const newEndDate = new Date(base.getTime() + days * 86400000);

        const updated = await prisma.user.update({
            where: { id: userId },
            data: {
                plan: 'PRO',
                subscriptionStatus: 'ACTIVE',
                planEndDate: newEndDate,
                manuallyUpgraded: true,
            },
            select: { id: true, email: true, plan: true, planEndDate: true },
        });

        await createAuditLog(req.userId, userId, 'EXTEND', {
            before: { planEndDate: user.planEndDate },
            after: { planEndDate: newEndDate, days },
        });
        res.json({ success: true, message: `Subscription extended by ${days} day(s)`, data: { user: updated } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to extend subscription', message: error.message });
    }
};

/**
 * Cancel a user's Razorpay subscription and set local status to CANCELLED.
 * The user keeps Pro access until planEndDate (graceful cancellation).
 */
const adminCancelSubscription = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId || !userId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        const { immediate = false } = req.body;

        // Find their Razorpay subscription ID from PaymentHistory
        const lastPayment = await prisma.paymentHistory.findFirst({
            where: { userId, status: 'SUCCESS' },
            orderBy: { createdAt: 'desc' },
            select: { razorpaySubscriptionId: true },
        });

        let razorpayError = null;
        if (lastPayment?.razorpaySubscriptionId) {
            console.log(`[Admin] Native subscription reference ${lastPayment.razorpaySubscriptionId} found for user ${userId}. (Manual cancel — no API call made)`);
        }

        await prisma.user.update({
            where: { id: userId },
            data: {
                subscriptionStatus: 'CANCELLED',
                ...(immediate && { plan: 'FREE', planEndDate: new Date() }),
            },
        });

        logAdminAction(req.userId, 'ADMIN_CANCEL_SUBSCRIPTION', userId);
        res.json({
            success: true,
            message: immediate ? 'Subscription cancelled immediately' : 'Subscription will cancel at period end',
            ...(razorpayError && { warning: `Razorpay API: ${razorpayError}` }),
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to cancel subscription', message: error.message });
    }
};

/**
 * Refund a specific Razorpay payment.
 * Body: { amount? } — in paise. Omit for full refund.
 */
const adminRefundPayment = async (req, res) => {
    try {
        const { paymentId } = req.params;
        const { amount, reason = 'customer_request' } = req.body;

        // Resolve userId from payment record BEFORE calling Razorpay
        const paymentRecord = await prisma.paymentHistory.findUnique({
            where: { razorpayPaymentId: paymentId },
            select: { userId: true, razorpaySubscriptionId: true },
        });

        if (!paymentRecord) {
            return res.status(404).json({ error: 'Payment record not found in database' });
        }

        // Refund logic for Google Play should be handled via Google Play Console/API service.
        // Razorpay refund logic removed.
        console.log(`[Admin] Refund requested for payment ${paymentId}. Manual action required in payment console.`);

        // Downgrade user plan immediately — they got their money back
        await prisma.user.update({
            where: { id: paymentRecord.userId },
            data: {
                plan: 'FREE',
                subscriptionStatus: 'EXPIRED',
                planEndDate: new Date(),
            },
        });

        logAdminAction(req.userId, 'ADMIN_REFUND', paymentId);
        res.json({
            success: true,
            message: `Refund initiated for ₹${((amount || refund.amount) / 100).toFixed(2)}. User downgraded to FREE.`,
            data: { refundId: refund.id, status: refund.status },
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to process refund', message: error.message });
    }
};

/**
 * Get full payment history for a specific user.
 */
const getSubscriptionHistory = async (req, res) => {
    try {
        const { userId } = req.params;
        const history = await prisma.paymentHistory.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
        res.json({ success: true, data: { history, count: history.length } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history', message: error.message });
    }
};

/**
 * Get global transaction history (All users).
 */
const getAllPayments = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = {};
        if (status) where.status = status.toUpperCase();

        const [payments, total] = await Promise.all([
            prisma.paymentHistory.findMany({
                where,
                include: { user: { select: { email: true, username: true } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.paymentHistory.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                payments,
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch global payments', message: error.message });
    }
};

/**
 * Get all subscriptions (using User plan fields as source of truth).
 */
const getSubscriptions = async (req, res) => {
    try {
        const { plan, status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { plan: { in: ['PRO', 'LIFETIME'] } };
        if (plan) where.plan = plan.toUpperCase();
        if (status) where.subscriptionStatus = status.toUpperCase();

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true, email: true, username: true,
                    plan: true, subscriptionStatus: true,
                    planSource: true, planStartDate: true, planEndDate: true,
                    manuallyUpgraded: true, createdAt: true,
                },
                orderBy: { planStartDate: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.user.count({ where }),
        ]);

        res.json({ success: true, data: { subscriptions: users, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch subscriptions', message: error.message });
    }
};

// ─── 4. ANALYTICS ──────────────────────────────────────────────────────
const getAnalytics = async (req, res) => {
    try {
        const { days: daysParam = 7 } = req.query;
        const numDays = Math.min(parseInt(daysParam), 30);

        const userGrowth = [];
        for (let i = numDays - 1; i >= 0; i--) {
            const from = new Date(Date.now() - i * 86400000);
            from.setHours(0, 0, 0, 0);
            const to = new Date(from);
            to.setHours(23, 59, 59, 999);
            const [users, proUsers] = await Promise.all([
                prisma.user.count({ where: { createdAt: { gte: from, lte: to } } }),
                // Use User.plan — subscription table is removed
                prisma.user.count({ where: { plan: { not: 'FREE' }, subscriptionStatus: 'ACTIVE', createdAt: { gte: from, lte: to } } }),
            ]);
            userGrowth.push({ date: from.toISOString().split('T')[0], users, proUsers, revenue: proUsers * 199 });
        }

        const [totalCaptions, totalPosts, totalTasks, totalDMRules, totalUsers, totalPro] = await Promise.all([
            prisma.caption.count(),
            prisma.scheduledPost.count(),
            prisma.calendarTask.count(),
            prisma.dMAutomation.count(),
            prisma.user.count(),
            prisma.user.count({ where: { plan: { not: 'FREE' }, subscriptionStatus: 'ACTIVE' } }),
        ]);

        const conversionRate = totalUsers > 0 ? ((totalPro / totalUsers) * 100).toFixed(1) : 0;
        const arpu = totalUsers > 0 ? ((totalPro * 199) / totalUsers).toFixed(0) : 0;

        res.json({
            success: true,
            data: {
                userGrowth,
                totalCaptions,
                totalPosts,
                totalTasks,
                totalDMRules,
                totalUsers,
                totalPro,
                conversionRate: parseFloat(conversionRate),
                arpu: parseFloat(arpu),
                featureUsage: {
                    captions: totalCaptions,
                    scheduledPosts: totalPosts,
                    dmAutomations: totalDMRules,
                    calendarTasks: totalTasks,
                },
            },
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch analytics', message: error.message });
    }
};

// ─── 5. SCHEDULED POSTS CONTROL ───────────────────────────────────────
const getScheduledPosts = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = {};
        if (status) where.status = status;

        const [posts, total] = await Promise.all([
            prisma.scheduledPost.findMany({
                where,
                include: { user: { select: { email: true, username: true } } },
                orderBy: { scheduledAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.scheduledPost.count({ where }),
        ]);
        res.json({ success: true, data: { posts, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch posts', message: error.message });
    }
};

const deleteScheduledPost = async (req, res) => {
    try {
        await prisma.scheduledPost.delete({ where: { id: req.params.id } });
        logAdminAction(req.userId, 'DELETE_POST', req.params.id);
        res.json({ success: true, message: 'Scheduled post cancelled' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to cancel post', message: error.message });
    }
};

const pauseSchedulingGlobally = async (req, res) => {
    try {
        appConfig.featureFlags.reelSchedulerEnabled = !appConfig.featureFlags.reelSchedulerEnabled;
        const state = appConfig.featureFlags.reelSchedulerEnabled;
        saveConfig();
        logAdminAction(req.userId, state ? 'RESUME_SCHEDULER' : 'PAUSE_SCHEDULER');
        res.json({ success: true, message: state ? 'Scheduler resumed' : 'Scheduler paused globally', enabled: state });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle scheduler', message: error.message });
    }
};

const retryFailedPost = async (req, res) => {
    try {
        const post = await prisma.scheduledPost.update({
            where: { id: req.params.id },
            data: { status: 'scheduled', errorMessage: null, retryCount: { increment: 1 } },
        });
        logAdminAction(req.userId, 'RETRY_POST', req.params.id);
        res.json({ success: true, message: 'Post queued for retry', data: { post } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retry post', message: error.message });
    }
};

// ─── 6. CAPTION MODERATION ─────────────────────────────────────────────
const getCaptions = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [captions, total] = await Promise.all([
            prisma.caption.findMany({
                include: { user: { select: { email: true, username: true } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.caption.count(),
        ]);
        res.json({ success: true, data: { captions, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch captions', message: error.message });
    }
};

const deleteCaption = async (req, res) => {
    try {
        await prisma.caption.delete({ where: { id: req.params.id } });
        res.json({ success: true, message: 'Caption deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete caption', message: error.message });
    }
};

// ─── 7. DM AUTOMATION LOGS ─────────────────────────────────────────────
const getDMAutomations = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [automations, total] = await Promise.all([
            prisma.dMAutomation.findMany({
                include: { user: { select: { email: true, username: true } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.dMAutomation.count(),
        ]);
        res.json({ success: true, data: { automations, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch automations', message: error.message });
    }
};

const stopAllAutomations = async (req, res) => {
    try {
        const { count: igCount } = await prisma.dMAutomation.updateMany({ data: { isActive: false } });
        const { count: ytCount } = await prisma.youtubeAutomationRule.updateMany({ data: { isActive: false } });
        
        appConfig.featureFlags.autoDMEnabled = false;
        appConfig.featureFlags.youtubeAutomationEnabled = false;
        saveConfig();
        
        logAdminAction(req.userId, 'STOP_ALL_DM_AND_YT');
        res.json({ success: true, message: `Stopped ${igCount} Instagram and ${ytCount} YouTube automation(s) globally.` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to stop automations', message: error.message });
    }
};

const deleteDMAutomation = async (req, res) => {
    try {
        await prisma.dMAutomation.delete({ where: { id: req.params.id } });
        logAdminAction(req.userId, 'DELETE_DM_RULE', req.params.id);
        res.json({ success: true, message: 'DM rule deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete DM rule', message: error.message });
    }
};

// ─── 8. BRAND DEALS CONTROL ────────────────────────────────────────────
const getBrandDeals = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [deals, total] = await Promise.all([
            prisma.brandDeal.findMany({
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.brandDeal.count(),
        ]);
        res.json({ success: true, data: { deals, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch brand deals', message: error.message });
    }
};

const createBrandDeal = async (req, res) => {
    try {
        const { senderUsername, dmContent, confidence = 0.9, dealCategory, isBrandDeal = true } = req.body;
        if (!senderUsername || !dmContent) return res.status(400).json({ error: 'senderUsername and dmContent required' });
        const deal = await prisma.brandDeal.create({
            data: { senderUsername, dmContent, confidence, dealCategory, isBrandDeal },
        });

        // Instagram-style Push Notification Broadcast
        try {
            const usersWithTokens = await prisma.user.findMany({
                where: { pushToken: { not: null } },
                select: { id: true, pushToken: true }
            });
            const tokens = usersWithTokens.map(u => u.pushToken).filter(pushNotificationService.isLikelyExpoToken);

            if (tokens.length > 0) {
                // 1. Create in-app notification records for all these users
                try {
                    await prisma.notification.createMany({
                        data: usersWithTokens.map(u => ({
                            userId: u.id,
                            type: 'brand_deal',
                            icon: 'briefcase',
                            color: '#F59E0B',
                            title: 'New Brand Deal Alert! 💸',
                            body: 'You have a new brand deal! Open the app to see details.',
                        }))
                    });
                } catch (dbErr) {
                    logger.warn('CREATE_BRAND_DEAL', `Failed to create DB notification records: ${dbErr.message}`);
                }

                // 2. Send Actual Push Notification
                await pushNotificationService.sendPushNotification(
                    tokens,
                    'New Brand Deal Alert! 💸',
                    'You have a new brand deal! Open the app to see details.',
                    { type: 'brand_deal', dealId: deal.id }
                );
            }
        } catch (pushErr) {
            logger.warn('CREATE_BRAND_DEAL', `Failed to broadcast push: ${pushErr.message}`);
        }

        logAdminAction(req.userId, 'CREATE_BRAND_DEAL', deal.id);
        res.json({ success: true, data: { deal } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create brand deal', message: error.message });
    }
};

const updateBrandDeal = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }
        const { senderUsername, dmContent, confidence, dealCategory, isBrandDeal } = req.body;
        const deal = await prisma.brandDeal.update({
            where: { id },
            data: { ...(senderUsername && { senderUsername }), ...(dmContent && { dmContent }), ...(confidence !== undefined && { confidence }), ...(dealCategory && { dealCategory }), ...(isBrandDeal !== undefined && { isBrandDeal }) },
        });
        logAdminAction(req.userId, 'UPDATE_BRAND_DEAL', id);
        res.json({ success: true, data: { deal } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update brand deal', message: error.message });
    }
};

const deleteBrandDeal = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }
        await prisma.brandDeal.delete({ where: { id } });
        logAdminAction(req.userId, 'DELETE_BRAND_DEAL', id);
        res.json({ success: true, message: 'Brand deal deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete brand deal', message: error.message });
    }
};

const markDealAsScam = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }
        const deal = await prisma.brandDeal.update({
            where: { id },
            data: { isBrandDeal: false, confidence: 0 },
        });
        logAdminAction(req.userId, 'MARK_SCAM', id);
        res.json({ success: true, message: 'Deal marked as scam', data: { deal } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark deal', message: error.message });
    }
};

const getDealReplies = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }
        const replies = await prisma.brandDealReply.findMany({
            where: { brandDealId: id },
            include: {
                user: {
                    select: { email: true, username: true, id: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Let's also grab their instagram followers if connected
        // Let's also grab their instagram followers if connected, AND 30day reach
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const repliesWithFollowers = await Promise.all(replies.map(async (reply) => {
            const igAccount = await prisma.instagramAccount.findUnique({
                where: { userId: reply.userId }
            });

            // Get highest reach or average reach in last 30days
            let maxReach = 'N/A';
            try {
                const snapshots = await prisma.analyticsSnapshot.findMany({
                    where: {
                        userId: reply.userId,
                        snapshotDate: { gte: thirtyDaysAgo }
                    },
                    select: { reach: true }
                });

                if (snapshots && snapshots.length > 0) {
                    const mappedReach = snapshots.map(s => s.reach).filter(r => typeof r === 'number');
                    if (mappedReach.length > 0) {
                        maxReach = Math.max(...mappedReach);
                    }
                }
            } catch (snapErr) {
                console.warn('Error fetching snapshots for reply reach:', snapErr);
            }

            return {
                ...reply,
                followers: igAccount ? igAccount.followers : 'N/A',
                reach: maxReach
            };
        }));

        res.json({ success: true, data: { replies: repliesWithFollowers } });
    } catch (error) {
        console.error('Error in getDealReplies:', error);
        res.status(500).json({ error: 'Failed to fetch replies', message: error.message, stack: error.stack });
    }
};

const aiShortlistReplies = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }

        const deal = await prisma.brandDeal.findUnique({ where: { id } });
        if (!deal) return res.status(404).json({ error: 'Deal not found' });

        const replies = await prisma.brandDealReply.findMany({
            where: { brandDealId: id },
            include: {
                user: { select: { username: true } }
            }
        });

        if (replies.length === 0) {
            return res.json({ success: true, message: 'No replies to shortlist' });
        }

        const prompt = `You are an AI talent scout for a brand deal.
Brand Deal Content: "${deal.dmContent}"

I have a list of profiles that pitched for this deal. Please analyze their pitches and select the BEST candidates (up to 30% of them) based on how well their pitch aligns with the brand.
Respond strictly in JSON format with an array of their IDs that you have SHORTLISTED. Look for professionalism, relevance, and enthusiasm.
JSON format: { "shortlistedIds": ["id1", "id2"] }

Candidates: 
${replies.map(r => `ID: ${r.id} | Username: ${r.user.username} | Pitch: "${r.pitch}"`).join('\n')}
`;

        let selectedIds = [];
        let tokensUsed = 0;

        if (process.env.OPENAI_API_KEY === 'dummy') {
            selectedIds = replies.slice(0, Math.max(1, Math.floor(replies.length / 2))).map(r => r.id);
        } else {
            const response = await openai.createChatCompletion({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'You output only valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
            });
            const content = response.data.choices[0].message.content.trim();
            tokensUsed = response.data.usage?.total_tokens || 0;
            const analysis = JSON.parse(content);
            selectedIds = analysis.shortlistedIds || [];
        }

        if (selectedIds.length > 0) {
            // Reset all to not shortlisted
            await prisma.brandDealReply.updateMany({
                where: { brandDealId: id },
                data: { isShortlisted: false }
            });

            // Set shortlisted ones
            await prisma.brandDealReply.updateMany({
                where: { id: { in: selectedIds } },
                data: { isShortlisted: true }
            });
        }

        await logAIUsage(req.userId, 'brand_deal', tokensUsed);

        res.json({ success: true, message: 'AI shortlisting complete', data: { shortlistedIds: selectedIds } });
    } catch (error) {
        console.error('AI Shortlist error:', error);
        res.status(500).json({ error: 'Failed to run AI shortlisting', message: error.message });
    }
};

const manualShortlist = async (req, res) => {
    try {
        const { id, replyId } = req.params;
        const { isShortlisted } = req.body;

        if (!replyId || !replyId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid reply ID' });
        }

        await prisma.brandDealReply.update({
            where: { id: replyId },
            data: { isShortlisted }
        });

        res.json({ success: true, message: isShortlisted ? 'User manually shortlisted' : 'User removed from shortlist' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update shortlist status', message: error.message });
    }
};

const sendDealNotifications = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }

        const deal = await prisma.brandDeal.findUnique({ where: { id } });
        if (!deal) return res.status(404).json({ error: 'Deal not found' });

        const replies = await prisma.brandDealReply.findMany({
            where: { brandDealId: id }
        });

        if (replies.length === 0) return res.status(400).json({ error: 'No replies to notify' });

        // Prepare notifications
        const notifications = replies.map(reply => {
            const isSelected = reply.isShortlisted;
            return {
                userId: reply.userId,
                type: 'brand_deal',
                icon: isSelected ? 'star' : 'close-circle',
                color: isSelected ? '#10B981' : '#F59E0B',
                title: isSelected ? 'Brand Deal Pitch: Shortlisted! 🎉' : 'Brand Deal Pitch Update',
                body: isSelected
                    ? `Congratulations! You have been shortlisted for the Brand Deal @${deal.senderUsername}. Watch your DMs for further steps!`
                    : `Thank you for pitching to @${deal.senderUsername}. Unfortunately, your profile wasn't selected this time. Better luck next time!`,
                read: false,
                createdAt: new Date()
            }
        });

        await prisma.notification.createMany({
            data: notifications
        });

        // Send actual Push Notifications
        const userIds = notifications.map(n => n.userId);
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, pushToken: true }
        });

        const usersById = new Map(users.map((u) => [u.id, u.pushToken]));
        await Promise.allSettled(
            notifications.map((notif) => {
                const token = usersById.get(notif.userId);
                if (!token) return Promise.resolve();

                return pushNotificationService.sendPushNotification(
                    token,
                    notif.title,
                    notif.body,
                    { type: 'brand_deal', dealId: id }
                );
            })
        );

        res.json({ success: true, message: `Sent notifications to ${notifications.length} users` });
    } catch (error) {
        console.error('Send Notifications error:', error);
        res.status(500).json({ error: 'Failed to send notifications', message: error.message });
    }
};

// ─── 9. NOTIFICATIONS ──────────────────────────────────────────────────
const broadcastNotification = async (req, res) => {
    try {
        const { title, body, type = 'system', target = 'all', userId: targetUserId } = req.body;
        if (!title || !body) return res.status(400).json({ error: 'title and body required' });

        // ─── FIX: Use User.plan (NOT deleted prisma.subscription table) ────
        let where = {};
        if (target === 'pro') {
            where = { plan: { not: 'FREE' }, subscriptionStatus: 'ACTIVE' };
        } else if (target === 'free') {
            where = { plan: 'FREE' };
        } else if (target === 'specific' && targetUserId) {
            where = { id: targetUserId };
        }
        // target === 'all' → where stays {} → all users

        const users = await prisma.user.findMany({
            where,
            select: { id: true, pushToken: true },
        });

        const results = await Promise.allSettled(
            users.map(async (u) => {
                await prisma.notification.create({
                    data: { userId: u.id, type, icon: 'megaphone', color: '#7C3AED', title, body },
                });
            })
        );

        const pushTokens = users
            .map((u) => u.pushToken)
            .filter(Boolean);

        if (pushTokens.length > 0) {
            await pushNotificationService.sendPushNotification(
                pushTokens,
                title,
                body,
                { type: type || 'system' }
            );
        }

        const sent = results.filter(r => r.status === 'fulfilled').length;
        logAdminAction(req.userId, 'BROADCAST_NOTIFICATION', `target:${target}`);
        res.json({ success: true, message: `Notification sent to ${sent}/${users.length} users` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to broadcast', message: error.message });
    }
};

// ─── 10. APP CONFIG PANEL ──────────────────────────────────────────────
const getAppConfig = async (req, res) => {
    res.json({ success: true, data: { config: appConfig } });
};

const updateAppConfig = async (req, res) => {
    try {
        const { subscriptionPrice, yearlyPrice, offerPriceMonthly, offerPriceYearly, freeFeatures, proFeatures, maintenanceMode, minAppVersion, featureFlags } = req.body;
        if (subscriptionPrice !== undefined) appConfig.subscriptionPrice = subscriptionPrice;
        if (yearlyPrice !== undefined) appConfig.yearlyPrice = yearlyPrice;
        if (offerPriceMonthly !== undefined) appConfig.offerPriceMonthly = offerPriceMonthly;
        if (offerPriceYearly !== undefined) appConfig.offerPriceYearly = offerPriceYearly;
        if (freeFeatures !== undefined) appConfig.freeFeatures = freeFeatures;
        if (proFeatures !== undefined) appConfig.proFeatures = proFeatures;
        if (maintenanceMode !== undefined) appConfig.maintenanceMode = maintenanceMode;
        if (minAppVersion !== undefined) appConfig.minAppVersion = minAppVersion;
        if (featureFlags) appConfig.featureFlags = { ...appConfig.featureFlags, ...featureFlags };
        saveConfig();
        logAdminAction(req.userId, 'UPDATE_APP_CONFIG');
        res.json({ success: true, message: 'Config updated', data: { config: appConfig } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update config', message: error.message });
    }
};

// ─── 11. AI FEATURE CONTROL ────────────────────────────────────────────
const getAIConfig = async (req, res) => {
    res.json({ success: true, data: { aiLimits: appConfig.aiLimits, blockedUsers: appConfig.blockedFromAI, featureFlags: appConfig.featureFlags } });
};

const updateAIConfig = async (req, res) => {
    try {
        const { aiLimits, featureFlags } = req.body;
        if (aiLimits) appConfig.aiLimits = { ...appConfig.aiLimits, ...aiLimits };
        if (featureFlags) {
            if (featureFlags.aiCaptionsEnabled !== undefined) appConfig.featureFlags.aiCaptionsEnabled = featureFlags.aiCaptionsEnabled;
            if (featureFlags.autoDMEnabled !== undefined) appConfig.featureFlags.autoDMEnabled = featureFlags.autoDMEnabled;
        }
        saveConfig();
        logAdminAction(req.userId, 'UPDATE_AI_CONFIG');
        res.json({ success: true, message: 'AI config updated', data: appConfig });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update AI config', message: error.message });
    }
};

const blockUserFromAI = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!appConfig.blockedFromAI.includes(userId)) {
            appConfig.blockedFromAI.push(userId);
            saveConfig();
        }
        logAdminAction(req.userId, 'BLOCK_USER_AI', userId);
        res.json({ success: true, message: 'User blocked from AI features', blockedUsers: appConfig.blockedFromAI });
    } catch (error) {
        res.status(500).json({ error: 'Failed to block user', message: error.message });
    }
};

const unblockUserFromAI = async (req, res) => {
    try {
        const { userId } = req.params;
        appConfig.blockedFromAI = appConfig.blockedFromAI.filter(id => id !== userId);
        saveConfig();
        logAdminAction(req.userId, 'UNBLOCK_USER_AI', userId);
        res.json({ success: true, message: 'User unblocked from AI features', blockedUsers: appConfig.blockedFromAI });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unblock user', message: error.message });
    }
};

// ─── 12. SECURITY PANEL ────────────────────────────────────────────────
const getSecurityLogs = async (req, res) => {
    try {
        // ─── FIX: adminActionLogs was an in-memory array that no longer exists.
        // Now we read from the DB-backed AuditLog table (created in Phase 3).
        const adminLogs = await prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
                id: true,
                adminId: true,
                targetId: true,
                action: true,
                details: true,
                createdAt: true,
            },
        });

        // Map to the shape the Security.jsx page expects:
        // { action, target, timestamp }
        const mappedLogs = adminLogs.map(l => ({
            action: l.action,
            target: l.targetId,
            timestamp: l.createdAt,
            adminId: l.adminId,
        }));

        const [suspendedUsers, bannedUsers] = await Promise.all([
            prisma.user.count({ where: { role: 'SUSPENDED' } }),
            prisma.user.count({ where: { role: 'BANNED' } }),
        ]);

        res.json({
            success: true,
            data: {
                adminLogs: mappedLogs,
                ipBlacklist,
                suspendedUsers,
                bannedUsers,
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch security logs', message: error.message });
    }
};

const blacklistIP = async (req, res) => {
    try {
        const { ip, reason } = req.body;
        if (!ip) return res.status(400).json({ error: 'IP required' });
        if (!ipBlacklist.find(e => e.ip === ip)) {
            ipBlacklist.unshift({ ip, reason: reason || 'Manual block', blockedAt: new Date().toISOString() });
        }
        logAdminAction(req.userId, 'BLACKLIST_IP', ip);
        res.json({ success: true, message: 'IP blacklisted', ipBlacklist });
    } catch (error) {
        res.status(500).json({ error: 'Failed to blacklist IP', message: error.message });
    }
};

const removeIPFromBlacklist = async (req, res) => {
    try {
        const { ip } = req.params;
        ipBlacklist = ipBlacklist.filter(e => e.ip !== ip);
        logAdminAction(req.userId, 'REMOVE_IP_BLACKLIST', ip);
        res.json({ success: true, message: 'IP removed from blacklist', ipBlacklist });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove IP', message: error.message });
    }
};

// ─── 13. AUDIT LOGS (DB-backed) ──────────────────────────────────────────────────────
const getAuditLogs = async (req, res) => {
    try {
        const { page = 1, limit = 50, targetId } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = {};
        if (targetId) where.targetId = targetId;

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.auditLog.count({ where }),
        ]);

        res.json({ success: true, data: { logs, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch audit logs', message: error.message });
    }
};

// ─── 14. SYSTEM METRICS (Phase 3 — Production Observability) ───────────────────
const getSystemMetrics = async (req, res) => {
    try {
        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3 * 86400000);
        const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
        const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const startOfMonth = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
        const costPerToken = parseFloat(process.env.OPENAI_COST_PER_TOKEN || '0.000002'); // USD per token

        // All 5 aggregations run in parallel — no N+1 queries
        const [
            activeProUsers,
            expiringIn3Days,
            aiUsageToday,
            aiUsageThisMonth,
            revenueThisMonth,
        ] = await Promise.all([
            // 1. Active PRO users
            prisma.user.count({
                where: { plan: 'PRO', subscriptionStatus: 'ACTIVE' },
            }),
            // 2. Users expiring within 3 days (churn risk)
            prisma.user.count({
                where: {
                    plan: 'PRO',
                    subscriptionStatus: 'ACTIVE',
                    planEndDate: { lte: threeDaysFromNow, gte: now },
                },
            }),
            // 3. AI tokens used today (from AIUsage table)
            prisma.aIUsage.aggregate({
                _sum: { tokens: true },
                where: { createdAt: { gte: startOfToday } },
            }),
            // 4. AI tokens used this month
            prisma.aIUsage.aggregate({
                _sum: { tokens: true },
                where: { month: currentMonth },
            }),
            // 5. Revenue this month (from PaymentHistory SUCCESS records)
            prisma.paymentHistory.aggregate({
                _sum: { amount: true },
                where: { status: 'SUCCESS', createdAt: { gte: startOfMonth } },
            }),
        ]);

        const tokensToday = aiUsageToday._sum.tokens ?? 0;
        const tokensMonth = aiUsageThisMonth._sum.tokens ?? 0;
        const revenuePaise = revenueThisMonth._sum.amount ?? 0;
        const globalBudget = parseInt(process.env.AI_MONTHLY_TOKEN_BUDGET || '5000000', 10);

        res.json({
            success: true,
            data: {
                subscriptions: {
                    activeProUsers,
                    expiringIn3Days,
                },
                ai: {
                    tokensToday,
                    tokensThisMonth: tokensMonth,
                    estimatedCostTodayUSD: (tokensToday * costPerToken).toFixed(4),
                    estimatedCostMonthUSD: (tokensMonth * costPerToken).toFixed(2),
                    globalMonthlyBudget: globalBudget,
                    budgetUsedPercent: ((tokensMonth / globalBudget) * 100).toFixed(1),
                },
                revenue: {
                    thisMonthINR: Math.round(revenuePaise / 100), // paise → rupees
                    thisMonthPaise: revenuePaise,
                },
                system: {
                    uptime: process.uptime(),
                    timestamp: now.toISOString(),
                },
            },
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch system metrics', message: error.message });
    }
};

// ─── 8. YOUTUBE AUTOMATION CONTROL ───────────────────────────────────
const getYouTubeRules = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [rules, total] = await Promise.all([
            prisma.youtubeAutomationRule.findMany({
                include: { user: { select: { email: true, username: true } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.youtubeAutomationRule.count(),
        ]);
        res.json({ success: true, data: { rules, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch YouTube rules', message: error.message });
    }
};

const updateYouTubeRule = async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive, replyMessage } = req.body;
        const rule = await prisma.youtubeAutomationRule.update({
            where: { id },
            data: {
                ...(isActive !== undefined && { isActive }),
                ...(replyMessage !== undefined && { replyMessage })
            },
            include: { user: { select: { email: true, username: true } } }
        });
        logAdminAction(req.userId, 'UPDATE_YOUTUBE_RULE', id);
        res.json({ success: true, message: 'YouTube rule updated', data: { rule } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update YouTube rule', message: error.message });
    }
};

const deleteYouTubeRule = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.youtubeAutomationRule.delete({ where: { id } });
        logAdminAction(req.userId, 'DELETE_YOUTUBE_RULE', id);
        res.json({ success: true, message: 'YouTube rule deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete YouTube rule', message: error.message });
    }
};

const getYouTubeComments = async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [comments, total] = await Promise.all([
            prisma.youtubeComment.findMany({
                include: { user: { select: { email: true, username: true } } },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.youtubeComment.count(),
        ]);
        res.json({ success: true, data: { comments, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch YouTube comments', message: error.message });
    }
};

const toggleYouTubeFeature = async (req, res) => {
    try {
        const { feature, enabled } = req.body;
        const { appConfig, saveConfig } = require('../config');

        if (!appConfig.featureFlags.hasOwnProperty(feature)) {
            return res.status(400).json({ error: 'Invalid feature flag' });
        }

        appConfig.featureFlags[feature] = enabled;
        saveConfig();

        logAdminAction(req.userId, 'TOGGLE_YOUTUBE_FEATURE', `${feature}:${enabled}`);
        res.json({
            success: true,
            message: `Feature ${feature} updated`,
            data: {
                featureFlags: appConfig.featureFlags
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle YouTube feature', message: error.message });
    }
};

const getYouTubeUserVideos = async (req, res) => {
    try {
        const { userId, maxResults = 20 } = req.query;
        if (!userId) return res.status(400).json({ error: 'User ID is required' });

        const { getUserVideos } = require('./youtubeController');
        // We temporarily override req.userId to reuse the existing controller logic
        const originalUserId = req.userId;
        req.userId = userId;
        await getUserVideos(req, res);
        req.userId = originalUserId;
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to fetch user videos', message: error.message });
        }
    }
};

const adminDeleteYouTubeVideo = async (req, res) => {
    try {
        const { userId, videoId } = req.params;
        const youtubeController = require('./youtubeController');

        // Setup req for the existing delete logic if it exists, or implement directly
        // YouTube API delete requires the authenticated client for that user
        const { google } = require('googleapis');
        const { decrypt } = require('../utils/cryptoUtils');

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || !user.youtubeAccessToken) throw new Error('User YouTube not connected');

        const oauth2Client = new google.auth.OAuth2(
            process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
            process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ access_token: decrypt(user.youtubeAccessToken) });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        await youtube.videos.delete({ id: videoId });

        logAdminAction(req.userId, 'ADMIN_DELETE_YOUTUBE_VIDEO', `${userId}:${videoId}`);
        res.json({ success: true, message: 'Video deleted from YouTube' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete YouTube video', message: error.message });
    }
};

const getYouTubeUserAnalytics = async (req, res) => {
    try {
        const { userId } = req.params;
        const { getChannelAnalytics } = require('./youtubeController');
        const originalUserId = req.userId;
        req.userId = userId;
        await getChannelAnalytics(req, res);
        req.userId = originalUserId;
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user analytics', message: error.message });
    }
};

module.exports = {
    getMetrics,
    getSystemMetrics,   // NEW: Phase 3 system observability
    getUsers,
    getUserDetail,
    deleteUser,
    resetUserPassword,
    suspendUser,
    banUser,
    // ── Subscription Admin ──
    adminUpgradeToPro,
    adminDowngradeToFree,
    adminGrantLifetime,
    adminExtendSubscription,
    adminCancelSubscription,
    adminRefundPayment,
    getSubscriptionHistory,
    getSubscriptions,
    // ── Analytics ──
    getAnalytics,
    getScheduledPosts,
    deleteScheduledPost,
    pauseSchedulingGlobally,
    retryFailedPost,
    getCaptions,
    deleteCaption,
    getDMAutomations,
    stopAllAutomations,
    deleteDMAutomation,
    getBrandDeals,
    createBrandDeal,
    updateBrandDeal,
    deleteBrandDeal,
    markDealAsScam,
    broadcastNotification,
    getAppConfig,
    updateAppConfig,
    getAIConfig,
    updateAIConfig,
    blockUserFromAI,
    unblockUserFromAI,
    getSecurityLogs,
    blacklistIP,
    removeIPFromBlacklist,
    getAuditLogs,
    getAllPayments,
    getDealReplies,
    aiShortlistReplies,
    manualShortlist,
    sendDealNotifications,
    getYouTubeRules,
    updateYouTubeRule,
    deleteYouTubeRule,
    getYouTubeComments,
    toggleYouTubeFeature,
    getYouTubeUserVideos,
    adminDeleteYouTubeVideo,
    getYouTubeUserAnalytics,
};
