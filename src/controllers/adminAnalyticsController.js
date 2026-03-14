const prisma = require('../lib/prisma');

/**
 * Admin Analytics Controller
 * Provides Stripe-style billing and subscriber metrics.
 */

// 1. Core Billing Dashboard
const getBillingDashboard = async (req, res) => {
    try {
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const firstDayOfYear = new Date(now.getFullYear(), 0, 1);

        // Revenue Aggregation
        const totalRevenueResult = await prisma.paymentHistory.aggregate({
            where: { status: { in: ['SUCCESS', 'PARTIALLY_REFUNDED'] } },
            _sum: { amount: true }
        });

        const monthlyRevenueResult = await prisma.paymentHistory.aggregate({
            where: {
                status: { in: ['SUCCESS', 'PARTIALLY_REFUNDED'] },
                createdAt: { gte: firstDayOfMonth }
            },
            _sum: { amount: true }
        });

        const yearlyRevenueResult = await prisma.paymentHistory.aggregate({
            where: {
                status: { in: ['SUCCESS', 'PARTIALLY_REFUNDED'] },
                createdAt: { gte: firstDayOfYear }
            },
            _sum: { amount: true }
        });

        const totalRevenue = (totalRevenueResult._sum.amount || 0) / 100;
        const monthlyRevenue = (monthlyRevenueResult._sum.amount || 0) / 100;
        const yearlyRevenue = (yearlyRevenueResult._sum.amount || 0) / 100;

        // Subscriber Metrics
        const activeSubscribers = await prisma.user.count({
            where: { plan: { in: ['PRO', 'LIFETIME'] }, subscriptionStatus: 'ACTIVE' }
        });

        const newSubscribersThisMonth = await prisma.user.count({
            where: {
                plan: { in: ['PRO', 'LIFETIME'] },
                planStartDate: { gte: firstDayOfMonth }
            }
        });

        const expiredSubscribers = await prisma.user.count({
            where: { subscriptionStatus: 'EXPIRED' }
        });

        const totalEverPaid = await prisma.user.count({
            where: { plan: { not: 'FREE' } }
        });

        const churnRate = totalEverPaid > 0
            ? (expiredSubscribers / (activeSubscribers + expiredSubscribers)) * 100
            : 0;

        const averageRevenuePerUser = activeSubscribers > 0 ? (monthlyRevenue / activeSubscribers) : 0;

        res.json({
            success: true,
            data: {
                totalRevenue,
                monthlyRevenue,
                yearlyRevenue,
                activeSubscribers,
                newSubscribersThisMonth,
                churnRate: parseFloat(churnRate.toFixed(2)),
                averageRevenuePerUser: parseFloat(averageRevenuePerUser.toFixed(2))
            }
        });
    } catch (error) {
        console.error('[AdminAnalytics] Billing Dashboard Error:', error);
        res.status(500).json({ error: 'Failed to fetch billing dashboard' });
    }
};

// 2. Monthly Revenue Chart
const getRevenueChart = async (req, res) => {
    try {
        const payments = await prisma.paymentHistory.findMany({
            where: { status: { in: ['SUCCESS', 'PARTIALLY_REFUNDED'] } },
            select: { amount: true, createdAt: true }
        });

        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthlyData = {};

        payments.forEach(p => {
            const date = new Date(p.createdAt);
            const key = `${months[date.getMonth()]} ${date.getFullYear()}`;
            monthlyData[key] = (monthlyData[key] || 0) + (p.amount / 100);
        });

        const chartData = Object.entries(monthlyData).map(([month, revenue]) => ({
            month,
            revenue: parseFloat(revenue.toFixed(2))
        })).sort((a, b) => new Date(a.month) - new Date(b.month));

        res.json({ success: true, data: { revenueByMonth: chartData } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch revenue chart' });
    }
};

// 3. Subscriber Growth
const getSubscriberGrowth = async (req, res) => {
    try {
        const newSubscribers = await prisma.user.count({
            where: { plan: { not: 'FREE' }, subscriptionStatus: 'ACTIVE' }
        });

        const cancelledSubscribers = await prisma.user.count({
            where: { subscriptionStatus: 'CANCELLED' }
        });

        const activeSubscribers = await prisma.user.count({
            where: { plan: { in: ['PRO', 'LIFETIME'] }, subscriptionStatus: 'ACTIVE' }
        });

        res.json({
            success: true,
            data: { newSubscribers, cancelledSubscribers, activeSubscribers }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch growth metrics' });
    }
};

// 4. Plan Distribution
const getPlanDistribution = async (req, res) => {
    try {
        const distribution = await prisma.user.groupBy({
            by: ['plan'],
            _count: { id: true }
        });

        const formatted = distribution.map(d => ({
            plan: d.plan,
            users: d._count.id
        }));

        res.json({ success: true, data: { plans: formatted } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch plan distribution' });
    }
};

// 5. Top Customers
const getTopCustomers = async (req, res) => {
    try {
        // Group by userId, sum amount
        const topPayments = await prisma.paymentHistory.groupBy({
            by: ['userId'],
            where: { status: 'SUCCESS' },
            _sum: { amount: true },
            orderBy: { _sum: { amount: 'desc' } },
            take: 10
        });

        const userIds = topPayments.map(p => p.userId);
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true }
        });

        const result = topPayments.map(p => ({
            userId: p.userId,
            email: users.find(u => u.id === p.userId)?.email || 'Unknown',
            totalSpent: (p._sum.amount || 0) / 100
        }));

        res.json({ success: true, data: { users: result } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch top customers' });
    }
};

// 6. Recent Transactions
const getRecentTransactions = async (req, res) => {
    try {
        const transactions = await prisma.paymentHistory.findMany({
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                userId: true,
                planId: true,
                amount: true,
                status: true,
                createdAt: true,
                transactionId: true
            }
        });

        const formatted = transactions.map(t => ({
            ...t,
            amount: t.amount / 100
        }));

        res.json({ success: true, data: { transactions: formatted } });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent transactions' });
    }
};

module.exports = {
    getBillingDashboard,
    getRevenueChart,
    getSubscriberGrowth,
    getPlanDistribution,
    getTopCustomers,
    getRecentTransactions
};
