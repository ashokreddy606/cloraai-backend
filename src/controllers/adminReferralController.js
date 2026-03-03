const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── GET /admin/referrals/overview ───────────────────────────────────────────
const getOverview = async (req, res) => {
    try {
        const [totalReferralsResult, totalPaidResult, transactions] = await Promise.all([
            prisma.user.aggregate({ _sum: { totalReferrals: true } }),
            prisma.user.aggregate({ _sum: { paidReferrals: true } }),
            prisma.referralTransaction.findMany({ select: { status: true } })
        ]);

        const totalReferrals = totalReferralsResult._sum.totalReferrals || 0;
        const totalPaidReferrals = totalPaidResult._sum.paidReferrals || 0;
        const conversionRate = totalReferrals > 0 ? ((totalPaidReferrals / totalReferrals) * 100).toFixed(2) + '%' : '0%';
        const revenueFromReferrals = totalPaidReferrals * 199; // Assume 199 INR per sub, or use real data if tied to amount

        res.json({
            success: true,
            data: {
                totalReferrals,
                totalPaidReferrals,
                conversionRate,
                estimatedRevenue: `₹${revenueFromReferrals}`,
                transactionStats: {
                    pending: transactions.filter(t => t.status === 'PENDING').length,
                    approved: transactions.filter(t => t.status === 'APPROVED').length,
                    blocked: transactions.filter(t => t.status === 'BLOCKED').length
                }
            }
        });
    } catch (error) {
        console.error('[AdminReferral] Overview error:', error);
        res.status(500).json({ error: 'Failed to fetch overview' });
    }
};

// ─── GET /admin/referrals/top-referrers ──────────────────────────────────────
const getTopReferrers = async (req, res) => {
    try {
        const topUsers = await prisma.user.findMany({
            where: { totalReferrals: { gt: 0 } },
            orderBy: { paidReferrals: 'desc' },
            take: 20,
            select: {
                id: true,
                username: true,
                email: true,
                totalReferrals: true,
                paidReferrals: true,
                milestoneClaimedCount: true,
                fraudScore: true,
                isFlagged: true
            }
        });

        res.json({
            success: true,
            data: topUsers.map(u => ({
                id: u.id,
                username: u.username,
                email: u.email,
                totalReferrals: u.totalReferrals,
                paidReferrals: u.paidReferrals,
                monthsEarned: u.milestoneClaimedCount,
                fraudScore: u.fraudScore,
                status: u.isFlagged ? 'FLAGGED' : 'CLEAN'
            }))
        });
    } catch (error) {
        console.error('[AdminReferral] Top Referrers error:', error);
        res.status(500).json({ error: 'Failed to fetch top referrers' });
    }
};

// ─── GET /admin/referrals/fraud-alerts ───────────────────────────────────────
const getFraudAlerts = async (req, res) => {
    try {
        const flaggedUsers = await prisma.user.findMany({
            where: { isFlagged: true },
            select: {
                id: true,
                username: true,
                email: true,
                fraudScore: true,
                ipAddress: true,
                deviceFingerprint: true
            }
        });

        const blockedTransactions = await prisma.referralTransaction.findMany({
            where: { status: 'BLOCKED' },
            include: {
                inviter: { select: { username: true, email: true } },
                referredUser: { select: { username: true, email: true } }
            },
            take: 50,
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            success: true,
            data: {
                flaggedUsers,
                blockedTransactions: blockedTransactions.map(tx => ({
                    id: tx.id,
                    inviter: tx.inviter.username,
                    referred: tx.referredUser.username,
                    reason: tx.fraudReason,
                    date: tx.createdAt
                }))
            }
        });
    } catch (error) {
        console.error('[AdminReferral] Fraud Alerts error:', error);
        res.status(500).json({ error: 'Failed to fetch fraud alerts' });
    }
};

// ─── POST /admin/referrals/adjust-credits ────────────────────────────────────
// Manually add or remove milestone claims (e.g., for support tickets)
const adjustCredits = async (req, res) => {
    try {
        const { userId, type, months } = req.body; // type: 'add' or 'remove'

        if (!userId || !type || !months) {
            return res.status(400).json({ error: 'userId, type (add/remove), and months are required' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const adjustment = type === 'add' ? parseInt(months) : -parseInt(months);
        const newEarned = Math.max(0, user.milestoneClaimedCount + adjustment);

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: { milestoneClaimedCount: newEarned },
            select: { id: true, username: true, milestoneClaimedCount: true, planEndDate: true }
        });

        // Note: This endpoint only adjusts the internal counter. 
        // Actual planEndDate extension would typically occur via the normal adminExtendSubscription API
        // if the admin wants to physically add time. This keeps financial ops explicit.

        res.json({
            success: true,
            message: `Manually ${type}ed ${months} months to ${updatedUser.username}'s milestone tracker.`,
            data: updatedUser
        });
    } catch (error) {
        console.error('[AdminReferral] Adjust credits error:', error);
        res.status(500).json({ error: 'Failed to adjust credits' });
    }
};

module.exports = {
    getOverview,
    getTopReferrers,
    getFraudAlerts,
    adjustCredits
};
