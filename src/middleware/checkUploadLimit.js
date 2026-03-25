const prisma = require('../lib/prisma');
const { appConfig } = require('../config');

/**
 * checkUploadLimit Middleware
 * Enforces the "1 video upload per day" limit for FREE users.
 * This should be applied to all video/reel upload endpoints.
 */
const checkUploadLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // 1. Get user and check plan
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { 
                plan: true, 
                subscriptionStatus: true, 
                planEndDate: true 
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // 2. Determine if user is PRO
        const isPro = user.plan === 'LIFETIME' || (
            user.plan === 'PRO' && 
            ['ACTIVE', 'CANCELLED'].includes(user.subscriptionStatus) && 
            user.planEndDate && 
            new Date(user.planEndDate) > new Date()
        );

        // 3. If NOT Pro, enforce daily limit
        if (!isPro) {
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);

            // Count uploads in ScheduledPost (all uploads should create a record there)
            const dailyUploadCount = await prisma.scheduledPost.count({
                where: {
                    userId: userId,
                    createdAt: { gte: startOfDay }
                }
            });

            if (dailyUploadCount >= 1) {
                return res.status(403).json({
                    success: false,
                    error: 'Free plan limit reached',
                    message: 'Free plan allows only 1 video upload per day. Upgrade to Pro for unlimited uploads!',
                    code: 'UPLOAD_LIMIT_REACHED',
                    limit: 1,
                    used: dailyUploadCount
                });
            }
        }

        // 4. Authorized
        next();
    } catch (error) {
        console.error('[UploadLimitGuard] Error:', error);
        res.status(500).json({ error: 'Internal server error while checking upload limits' });
    }
};

module.exports = checkUploadLimit;
