const prisma = require('../lib/prisma');
const axios = require('axios');
const { appConfig } = require('../config');
const { instagramQueue, youtubeQueue, enqueueJob } = require('../utils/queue');

// Schedule Post
const schedulePost = async (req, res) => {
  try {
    const { 
      caption, hashtags, scheduledTime, mediaUrl, captionId, publishInstantly,
      // Advanced Automation
      isAI, triggerType, replyType, productName, productUrl, 
      productDescription, productImage, mustFollow, dmButtonText, publicReplies,
      automationKeyword, automationReply, automationAppendLinks, automationLinks,
      customFollowEnabled, customFollowHeader, customFollowSubtext, 
      followButtonText, followedButtonText, dmReplyEnabled
    } = req.body;

    if (!appConfig.featureFlags.reelSchedulerEnabled) {
      return res.status(403).json({
        error: 'Feature Disabled',
        message: 'The Reel Scheduler has been temporarily disabled by the administrator.'
      });
    }

    if (!caption || !mediaUrl || (!scheduledTime && !publishInstantly)) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'caption, mediaUrl, and scheduledTime (or publishInstantly) are required'
      });
    }

    const scheduledDate = publishInstantly ? new Date() : new Date(scheduledTime);

    // Validate mediaUrl format (Must be a secure HTTP/HTTPS URL)
    const urlPattern = /^https?:\/\/.+/i;
    if (!urlPattern.test(mediaUrl)) {
      return res.status(400).json({
        error: 'Invalid media URL',
        message: 'mediaUrl must be a valid HTTP or HTTPS accessible string'
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { plan: true, subscriptionStatus: true, planEndDate: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });


    const { platform: reqPlatform } = req.body;
    const isInstant = !!publishInstantly;

    const scheduledPost = await prisma.scheduledPost.create({
      data: {
        user: { connect: { id: req.userId } },
        caption,
        mediaUrl,
        scheduledAt: scheduledDate,
        status: isInstant ? 'publishing' : 'scheduled',
        automationKeyword: automationKeyword || null,
        automationReply: automationReply || null,
        automationAppendLinks: automationAppendLinks || false,
        automationLinks: automationLinks ? (typeof automationLinks === 'string' ? automationLinks : JSON.stringify(automationLinks)) : null,
        platform: reqPlatform || 'instagram',
        // Advanced Automation Integration
        isAI: isAI === 'true' || isAI === true,
        triggerType: triggerType || null,
        replyType: replyType || null,
        productName: productName || null,
        productUrl: productUrl || null,
        productDescription: productDescription || null,
        productImage: productImage || null,
        mustFollow: mustFollow === 'true' || mustFollow === true,
        dmButtonText: dmButtonText || null,
        publicReplies: publicReplies || null,
        customFollowEnabled: customFollowEnabled === 'true' || customFollowEnabled === true,
        customFollowHeader: customFollowHeader || null,
        customFollowSubtext: customFollowSubtext || null,
        followButtonText: followButtonText || null,
        followedButtonText: followedButtonText || null,
        dmReplyEnabled: dmReplyEnabled === 'true' || dmReplyEnabled === true
      }
    });

    // If instant, add to queue immediately
    if (isInstant) {
      if (scheduledPost.platform === 'instagram') {
        await enqueueJob(instagramQueue, 'publish', { postId: scheduledPost.id, userId: req.userId });
      } else if (scheduledPost.platform === 'youtube') {
        await enqueueJob(youtubeQueue, 'upload', { postId: scheduledPost.id, userId: req.userId });
      }
    }

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
          scheduledAt: scheduledPost.scheduledAt
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
      orderBy: { scheduledAt: 'asc' }
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
