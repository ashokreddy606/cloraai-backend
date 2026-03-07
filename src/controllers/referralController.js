const prisma = require('../lib/prisma');

// Get the current user's referral stats
const getReferralStats = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: {
                referralCode: true,
                totalReferrals: true,
                paidReferrals: true,
                milestoneClaimedCount: true,
                referrals: {
                    select: { id: true, username: true, createdAt: true, plan: true }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Backfill referral codes for older users who registered before the system was added
        if (!user.referralCode) {
            const newReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4);
            await prisma.user.update({
                where: { id: req.userId },
                data: { referralCode: newReferralCode }
            });
            user.referralCode = newReferralCode;
        }

        const requiredTotalDesc = 25;
        const requiredPaidPerMilestone = 5;

        const nextMilestoneAt = (user.milestoneClaimedCount + 1) * requiredPaidPerMilestone;
        const isEligible = user.totalReferrals >= requiredTotalDesc;

        res.status(200).json({
            success: true,
            data: {
                referralCode: user.referralCode,
                totalReferred: user.totalReferrals,
                paidReferrals: user.paidReferrals,
                monthsEarned: user.milestoneClaimedCount,
                nextMilestoneAt,
                eligibilityStatus: isEligible
                    ? `Eligible (Need ${nextMilestoneAt - user.paidReferrals} more paid referrals for next reward)`
                    : `Needs ${requiredTotalDesc - user.totalReferrals} more total signups to unlock milestone rewards.`,
                rawReferrals: user.referrals
            }
        });
    } catch (error) {
        console.error('Failed to get referral stats:', error);
        res.status(500).json({
            error: 'Failed to fetch referrals',
            message: error.message
        });
    }
};

module.exports = {
    getReferralStats
};
