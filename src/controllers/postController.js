const prisma = require('../lib/prisma');

/**
 * Bulk schedule posts across platforms
 * POST /posts/bulk-schedule
 */
const bulkSchedule = async (req, res) => {
    try {
        const postsData = req.body; // Array of posts
        if (!Array.isArray(postsData) || postsData.length === 0) {
            return res.status(400).json({ error: 'Array of posts is required' });
        }

        const userId = req.userId;

        const postsToCreate = postsData.map(post => ({
            userId,
            platform: post.platform || 'instagram',
            mediaUrl: post.mediaUrl,
            title: post.title || null,
            caption: post.caption || '',
            scheduledAt: new Date(post.scheduledAt),
            status: 'scheduled',
            videoType: post.videoType || null
        }));

        const result = await prisma.scheduledPost.createMany({
            data: postsToCreate
        });

        res.status(201).json({
            success: true,
            message: `${result.count} posts scheduled successfully`,
            count: result.count
        });
    } catch (error) {
        console.error('Bulk schedule error:', error);
        res.status(500).json({ error: 'Failed to bulk schedule posts', message: error.message });
    }
};

module.exports = {
    bulkSchedule
};
