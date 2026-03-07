const prisma = require('../lib/prisma');
const axios = require('axios');
const { appConfig } = require('../config');

// Schedule Post
const schedulePost = async (req, res) => {
  try {
    const { caption, hashtags, scheduledTime, mediaUrl, captionId } = req.body;

    if (!appConfig.featureFlags.reelSchedulerEnabled) {
      return res.status(403).json({
        error: 'Feature Disabled',
        message: 'The Reel Scheduler has been temporarily disabled by the administrator.'
      });
    }

    if (!caption || !mediaUrl || !scheduledTime) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'caption, mediaUrl, and scheduledTime are required'
      });
    }

    // Validate mediaUrl format (Must be a secure HTTP/HTTPS URL)
    const urlPattern = /^https?:\/\/.+/i;
    if (!urlPattern.test(mediaUrl)) {
      return res.status(400).json({
        error: 'Invalid media URL',
        message: 'mediaUrl must be a valid HTTP or HTTPS accessible string'
      });
    }

    // Check plan from User model (source of truth)
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { plan: true, subscriptionStatus: true, planEndDate: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    const isPro =
      user.plan === 'LIFETIME' ||
      (
        user.plan === 'PRO' &&
        ['ACTIVE', 'CANCELLED'].includes(user.subscriptionStatus) &&
        user.planEndDate &&
        new Date(user.planEndDate) > new Date()
      );

    if (!isPro) {
      // FREE users: max 4 scheduled posts per calendar month
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const monthlyCount = await prisma.scheduledPost.count({
        where: {
          userId: req.userId,
          createdAt: { gte: startOfMonth },
        },
      });

      if (monthlyCount >= 4) {
        return res.status(403).json({
          error: 'Free plan limit reached',
          message: 'Free plan allows 4 scheduled posts per month. Upgrade to Pro for unlimited scheduling.',
          code: 'PLAN_LIMIT',
          limit: 4,
          used: monthlyCount,
        });
      }
    }

    const scheduledPost = await prisma.scheduledPost.create({
      data: {
        userId: req.userId,
        caption,
        hashtags: hashtags || '',
        mediaUrl,
        scheduledTime: new Date(scheduledTime),
        status: 'scheduled'
      }
    });

    if (captionId) {
      await prisma.caption.update({
        where: { id: captionId },
        data: {
          isUsed: true,
          usedInPostId: scheduledPost.id,
          usedAt: new Date()
        }
      }).catch(e => console.warn('Caption use update failed:', e.message));
    }

    res.status(201).json({
      success: true,
      data: {
        post: {
          id: scheduledPost.id,
          status: scheduledPost.status,
          scheduledTime: scheduledPost.scheduledTime
        }
      }
    });
  } catch (error) {
    console.error('Schedule post error:', error);
    res.status(500).json({
      error: 'Failed to schedule post',
      message: error.message
    });
  }
};

// Get Scheduled Posts
const getScheduledPosts = async (req, res) => {
  try {
    const posts = await prisma.scheduledPost.findMany({
      where: { userId: req.userId },
      orderBy: { scheduledTime: 'asc' }
    });

    res.status(200).json({
      success: true,
      data: {
        posts
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch posts',
      message: error.message
    });
  }
};

// Cancel Scheduled Post
const cancelPost = async (req, res) => {
  try {
    const { id } = req.params;

    const post = await prisma.scheduledPost.findUnique({
      where: { id }
    });

    if (!post || post.userId !== req.userId) {
      return res.status(404).json({
        error: 'Post not found'
      });
    }

    await prisma.scheduledPost.delete({
      where: { id }
    });

    res.status(200).json({
      success: true,
      message: 'Post cancelled successfully'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to cancel post',
      message: error.message
    });
  }
};

module.exports = {
  schedulePost,
  getScheduledPosts,
  cancelPost
};
