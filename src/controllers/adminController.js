const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../utils/helpers');
const { appConfig, saveConfig } = require('../config');
const { cancelSubscription: rzpCancelSub, createRefund } = require('../services/razorpayService');
const logger = require('../utils/logger');
const prisma = new PrismaClient();

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
                    // razorpaySubscriptionId / razorpayPaymentId left null (optional fields)
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
            try {
                await rzpCancelSub(userRecord.activeRazorpaySubscriptionId, false); // immediate
                console.log(`[Admin] Razorpay sub ${userRecord.activeRazorpaySubscriptionId} cancelled for user ${userId}`);
            } catch (err) {
                console.warn('[Admin] Razorpay cancel on downgrade warning:', err.message);
            }
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
        const { immediate = false } = req.body;

        // Find their Razorpay subscription ID from PaymentHistory
        const lastPayment = await prisma.paymentHistory.findFirst({
            where: { userId, status: 'SUCCESS' },
            orderBy: { createdAt: 'desc' },
            select: { razorpaySubscriptionId: true },
        });

        let razorpayError = null;
        if (lastPayment?.razorpaySubscriptionId) {
            try {
                await rzpCancelSub(lastPayment.razorpaySubscriptionId, !immediate);
            } catch (err) {
                razorpayError = err.message;
                console.warn('[Admin] Razorpay cancel API warning:', err.message);
            }
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

        const refund = await createRefund(paymentId, amount || null, reason);

        // Mark payment as refunded
        await prisma.paymentHistory.updateMany({
            where: { razorpayPaymentId: paymentId },
            data: { status: 'REFUNDED' },
        });

        // Cancel Razorpay subscription to prevent re-billing
        if (paymentRecord.razorpaySubscriptionId) {
            try {
                await rzpCancelSub(paymentRecord.razorpaySubscriptionId, false);
            } catch (err) {
                console.warn('[Admin] Razorpay cancel during refund warning:', err.message);
            }
        }

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
                orderBy: { scheduledTime: 'desc' },
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
        const { count } = await prisma.dMAutomation.updateMany({ data: { isActive: false } });
        appConfig.featureFlags.autoDMEnabled = false;
        saveConfig();
        logAdminAction(req.userId, 'STOP_ALL_DM');
        res.json({ success: true, message: `Stopped ${count} automation(s)` });
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
        logAdminAction(req.userId, 'CREATE_BRAND_DEAL', deal.id);
        res.json({ success: true, data: { deal } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create brand deal', message: error.message });
    }
};

const updateBrandDeal = async (req, res) => {
    try {
        const { senderUsername, dmContent, confidence, dealCategory, isBrandDeal } = req.body;
        const deal = await prisma.brandDeal.update({
            where: { id: req.params.id },
            data: { ...(senderUsername && { senderUsername }), ...(dmContent && { dmContent }), ...(confidence !== undefined && { confidence }), ...(dealCategory && { dealCategory }), ...(isBrandDeal !== undefined && { isBrandDeal }) },
        });
        logAdminAction(req.userId, 'UPDATE_BRAND_DEAL', req.params.id);
        res.json({ success: true, data: { deal } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update brand deal', message: error.message });
    }
};

const deleteBrandDeal = async (req, res) => {
    try {
        await prisma.brandDeal.delete({ where: { id: req.params.id } });
        logAdminAction(req.userId, 'DELETE_BRAND_DEAL', req.params.id);
        res.json({ success: true, message: 'Brand deal deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete brand deal', message: error.message });
    }
};

const markDealAsScam = async (req, res) => {
    try {
        const deal = await prisma.brandDeal.update({
            where: { id: req.params.id },
            data: { isBrandDeal: false, confidence: 0 },
        });
        logAdminAction(req.userId, 'MARK_SCAM', req.params.id);
        res.json({ success: true, message: 'Deal marked as scam', data: { deal } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark deal', message: error.message });
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

        let nodeFetch;
        try { nodeFetch = require('node-fetch'); } catch (e) { nodeFetch = null; }

        const results = await Promise.allSettled(
            users.map(async (u) => {
                await prisma.notification.create({
                    data: { userId: u.id, type, icon: 'megaphone', color: '#7C3AED', title, body },
                });
                if (nodeFetch && u.pushToken && u.pushToken.startsWith('ExponentPushToken')) {
                    await nodeFetch('https://exp.host/--/api/v2/push/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ to: u.pushToken, sound: 'default', title, body }),
                    }).catch(() => { });
                }
            })
        );

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
};
