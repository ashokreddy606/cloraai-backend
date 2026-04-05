const prisma = require('../lib/prisma');
const FinancialService = require('../services/FinancialService');

/**
 * Admin Analytics Controller
 * Provides Stripe-style billing and subscriber metrics.
 */

// 1. Core Billing Dashboard
const getBillingDashboard = async (req, res) => {
    try {
        const [
            mrr, 
            arr, 
            arpu, 
            breakdown, 
            activeSubscribers,
            churnRiskCount
        ] = await Promise.all([
            FinancialService.getMRR(),
            FinancialService.getARR(),
            FinancialService.getARPU(),
            FinancialService.getBreakdown(),
            prisma.user.count({ where: { plan: { in: ['PRO', 'LIFETIME'] }, subscriptionStatus: 'ACTIVE' } }),
            prisma.user.count({ where: { subscriptionStatus: { in: ['PAST_DUE', 'HALTED'] } } })
        ]);

        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const monthlyRevenueResult = await prisma.paymentHistory.aggregate({
            where: { status: 'SUCCESS', createdAt: { gte: firstDayOfMonth } },
            _sum: { amount: true }
        });

        res.json({
            success: true,
            data: {
                mrr,
                arr,
                arpu,
                activeSubscribers,
                monthlyRevenue: (monthlyRevenueResult._sum.amount || 0) / 100,
                churnRiskCount,
                breakdown
            }
        });
    } catch (error) {
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

/**
 * 7. Daily Revenue API
 * GET /api/admin/revenue/daily
 */
const getDailyRevenue = async (req, res) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const revenueResult = await prisma.paymentHistory.aggregate({
            where: {
                status: 'SUCCESS',
                createdAt: { gte: startOfDay }
            },
            _sum: { amount: true },
            _count: { id: true }
        });

        res.json({
            success: true,
            data: {
                totalRevenue: (revenueResult._sum.amount || 0) / 100,
                totalPayments: revenueResult._count.id,
                date: startOfDay.toISOString().split('T')[0]
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * 8. MRR Calculation API
 * GET /api/admin/mrr
 */
const getMRR = async (req, res) => {
    try {
        const monthlyUsers = await prisma.user.count({
            where: { plan: 'PRO', subscriptionStatus: 'ACTIVE', billingCycle: 'MONTHLY' }
        });
        const yearlyUsers = await prisma.user.count({
            where: { plan: 'PRO', subscriptionStatus: 'ACTIVE', billingCycle: 'YEARLY' }
        });

        // Netflix Model: MRR = (Monthly * 299) + (Yearly * 2499 / 12)
        const mrr = (monthlyUsers * 299) + (yearlyUsers * (2499 / 12));

        res.json({
            success: true,
            data: {
                mrr: parseFloat(mrr.toFixed(2)),
                monthlyUsers,
                yearlyUsers,
                breakdown: {
                    monthlyRevenue: monthlyUsers * 299,
                    yearlyRevenueContribution: parseFloat((yearlyUsers * (2499 / 12)).toFixed(2))
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * 9. Customer Segments API
 * GET /api/admin/billing/segments
 */
const getCustomerSegments = async (req, res) => {
    try {
        const [topCustomers, riskUsers] = await Promise.all([
            FinancialService.getTopCustomers(20),
            FinancialService.getChurnRiskUsers()
        ]);

        res.json({
            success: true,
            data: { topCustomers, riskUsers }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch segments' });
    }
};

module.exports = {
    getBillingDashboard,
    getRevenueChart,
    getSubscriberGrowth,
    getPlanDistribution,
    getTopCustomers,
    getRecentTransactions,
    getDailyRevenue,
    getMRR,
    getCustomerSegments
};
