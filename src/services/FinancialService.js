/**
 * src/services/FinancialService.js
 * SaaS Revenue Intelligence Engine
 */

const prisma = require('../lib/prisma');
const { appConfig } = require('../config');

class FinancialService {
    /**
     * Calculate MRR (Monthly Recurring Revenue)
     * Model: (Monthly Active Users * Pro Monthly) + (Yearly Active Users * (Pro Yearly / 12))
     */
    async getMRR() {
        const monthlyUsers = await prisma.user.count({
            where: { plan: 'PRO', subscriptionStatus: 'ACTIVE', billingCycle: 'MONTHLY' }
        });
        const yearlyUsers = await prisma.user.count({
            where: { plan: 'PRO', subscriptionStatus: 'ACTIVE', billingCycle: 'YEARLY' }
        });

        const monthlyPrice = appConfig.subscriptionPrice || 299;
        const yearlyPrice = appConfig.yearlyPrice || 2499;

        const mrr = (monthlyUsers * monthlyPrice) + (yearlyUsers * (yearlyPrice / 12));
        return parseFloat(mrr.toFixed(2));
    }

    /**
     * Calculate ARR (Annual Recurring Revenue)
     */
    async getARR() {
        const currentMRR = await this.getMRR();
        return currentMRR * 12;
    }

    /**
     * Calculate ARPU (Average Revenue Per User)
     * For active subscribers only.
     */
    async getARPU() {
        const activeCount = await prisma.user.count({
            where: { plan: { in: ['PRO', 'LIFETIME'] }, subscriptionStatus: 'ACTIVE' }
        });
        if (activeCount === 0) return 0;

        const mrr = await this.getMRR();
        return parseFloat((mrr / activeCount).toFixed(2));
    }

    /**
     * Get Revenue Breakdown by Plan
     */
    async getBreakdown() {
        const monthlyCount = await prisma.user.count({ where: { plan: 'PRO', billingCycle: 'MONTHLY', subscriptionStatus: 'ACTIVE' } });
        const yearlyCount = await prisma.user.count({ where: { plan: 'PRO', billingCycle: 'YEARLY', subscriptionStatus: 'ACTIVE' } });
        const lifetimeCount = await prisma.user.count({ where: { plan: 'LIFETIME' } });

        return {
            monthly: { count: monthlyCount, mrr: monthlyCount * (appConfig.subscriptionPrice || 299) },
            yearly: { count: yearlyCount, mrr: yearlyCount * ((appConfig.yearlyPrice || 2499) / 12) },
            lifetime: { count: lifetimeCount }
        };
    }

    /**
     * Identify Churn Risk Users
     * Criteria: Payment failed (PAST_DUE) or Halted in the last 7 days.
     */
    async getChurnRiskUsers() {
        return prisma.user.findMany({
            where: {
                OR: [
                    { subscriptionStatus: 'PAST_DUE' },
                    { subscriptionStatus: 'HALTED' }
                ]
            },
            select: { id: true, email: true, username: true, subscriptionStatus: true, planEndDate: true },
            take: 10
        });
    }

    /**
     * Get Top Customers by Lifetime Value
     */
    async getTopCustomers(limit = 10) {
        const topPayments = await prisma.paymentHistory.groupBy({
            by: ['userId'],
            where: { status: 'SUCCESS' },
            _sum: { amount: true },
            orderBy: { _sum: { amount: 'desc' } },
            take: limit
        });

        const userIds = topPayments.map(p => p.userId);
        const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, username: true }
        });

        return topPayments.map(p => ({
            userId: p.userId,
            email: users.find(u => u.id === p.userId)?.email || 'Unknown',
            username: users.find(u => u.id === p.userId)?.username || 'Unknown',
            lifetimeValue: (p._sum.amount || 0) / 100
        }));
    }
}

module.exports = new FinancialService();
