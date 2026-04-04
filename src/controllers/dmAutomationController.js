const prisma = require('../lib/prisma');
const { appConfig } = require('../config');
const logger = require('../utils/logger');
const pushNotificationService = require('../services/pushNotificationService');
const { cache } = require('../utils/cache');

// Create DM Automation Rule
const createRule = async (req, res) => {
  try {
    const { 
      keyword, autoReplyMessage, reelId, appendLinks, link1, link2, link3, link4,
      isAI, triggerType, replyType, publicReplies, productName, productUrl, 
      productDescription, mustFollow,
      customFollowEnabled, customFollowHeader, customFollowSubtext, 
      followButtonText, followedButtonText, dmButtonText
    } = req.body;

    if (!appConfig.featureFlags.autoDMEnabled) {
      return res.status(403).json({
        error: 'Feature Disabled',
        message: 'DM Automation has been temporarily disabled by the administrator.'
      });
    }

    if (!isAI && !keyword && triggerType !== 'any') {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'keyword is required when triggerType is not "any"'
      });
    }

    if (!isAI && !autoReplyMessage && replyType !== 'product') {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'autoReplyMessage is required when replyType is not "product" and isAI is false'
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
      // FREE users: max 3 DM automation rules total
      const ruleCount = await prisma.dMAutomation.count({
        where: { userId: req.userId },
      });

      if (ruleCount >= 1) {
        return res.status(403).json({
          error: 'Free plan limit reached',
          message: 'Free plan allows 1 Instagram DM automation rule. Upgrade to Pro for unlimited rules.',
          code: 'PLAN_LIMIT',
          limit: 1,
          used: ruleCount,
        });
      }
    }

    // ── PLAY STORE COMPLIANCE: Anti-Spam Safety Check ──
    if (autoReplyMessage && !isAI) {
        if (autoReplyMessage.length < 5 || /http|www|\.com/i.test(autoReplyMessage)) {
          return res.status(400).json({
            error: 'Policy Violation',
            message: 'Auto-reply messages must be meaningful and cannot contain external links to prevent spam flags.'
          });
        }
    }

    const rule = await prisma.dMAutomation.create({
      data: {
        userId: req.userId,
        keyword: keyword || null,
        autoReplyMessage: autoReplyMessage || null,
        isActive: true,
        reelId: reelId || null,
        isAI: !!isAI,
        triggerType: triggerType || 'keywords',
        replyType: replyType || 'text',
        publicReplies: typeof publicReplies === 'string' ? publicReplies : JSON.stringify(publicReplies || []),
        productName: productName || null,
        productUrl: productUrl || null,
        productDescription: productDescription || null,
        mustFollow: !!mustFollow,
        customFollowEnabled: !!customFollowEnabled,
        customFollowHeader: customFollowHeader || null,
        customFollowSubtext: customFollowSubtext || null,
        followButtonText: followButtonText || null,
        followedButtonText: followedButtonText || null,
        dmButtonText: dmButtonText || null,
        appendLinks: appendLinks || false,
        link1: link1 || null,
        link2: link2 || null,
        link3: link3 || null,
        link4: link4 || null
      }
    });

    // ✅ ULTRA-SPEED: Invalidate rules cache for this user
    await cache.del(`rules:ig:${req.userId}`);

    res.status(201).json({
      success: true,
      data: {
        rule
      }
    });
  } catch (error) {
    logger.error('DM_AUTOMATION', 'Create rule error', { error: error.message, userId: req.userId });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Get DM Automation Rules
const getRules = async (req, res) => {
  try {
    const rules = await prisma.dMAutomation.findMany({
      where: { userId: req.userId }
    });

    res.status(200).json({
      success: true,
      data: {
        rules
      }
    });
  } catch (error) {
    logger.error('DM_AUTOMATION', 'Get rules error', { error: error.message, userId: req.userId });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Update DM Automation Rule
const updateRule = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      keyword, autoReplyMessage, isActive, reelId, appendLinks, link1, link2, link3, link4,
      isAI, triggerType, replyType, publicReplies, productName, productUrl, 
      productDescription, mustFollow,
      customFollowEnabled, customFollowHeader, customFollowSubtext, 
      followButtonText, followedButtonText, dmButtonText
    } = req.body;

    // Verify ownership
    const existingRule = await prisma.dMAutomation.findUnique({
      where: { id }
    });

    if (!existingRule) {
      return res.status(404).json({
        error: 'Rule not found'
      });
    }

    if (existingRule.userId !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only update your own rules'
      });
    }

    const rule = await prisma.dMAutomation.update({
      where: { id },
      data: {
        ...(keyword !== undefined && { keyword: keyword || null }),
        ...(autoReplyMessage !== undefined && { autoReplyMessage: autoReplyMessage || null }),
        ...(isActive !== undefined && { isActive }),
        ...(reelId !== undefined && { reelId: reelId || null }),
        ...(isAI !== undefined && { isAI: !!isAI }),
        ...(triggerType !== undefined && { triggerType }),
        ...(replyType !== undefined && { replyType }),
        ...(publicReplies !== undefined && { publicReplies: typeof publicReplies === 'string' ? publicReplies : JSON.stringify(publicReplies || []) }),
        ...(productName !== undefined && { productName: productName || null }),
        ...(productUrl !== undefined && { productUrl: productUrl || null }),
        ...(productDescription !== undefined && { productDescription: productDescription || null }),
        ...(mustFollow !== undefined && { mustFollow: !!mustFollow }),
        ...(customFollowEnabled !== undefined && { customFollowEnabled: !!customFollowEnabled }),
        ...(customFollowHeader !== undefined && { customFollowHeader: customFollowHeader || null }),
        ...(customFollowSubtext !== undefined && { customFollowSubtext: customFollowSubtext || null }),
        ...(followButtonText !== undefined && { followButtonText: followButtonText || null }),
        ...(followedButtonText !== undefined && { followedButtonText: followedButtonText || null }),
        ...(dmButtonText !== undefined && { dmButtonText: dmButtonText || null }),
        ...(appendLinks !== undefined && { appendLinks }),
        ...(link1 !== undefined && { link1: link1 || null }),
        ...(link2 !== undefined && { link2: link2 || null }),
        ...(link3 !== undefined && { link3: link3 || null }),
        ...(link4 !== undefined && { link4: link4 || null })
      }
    });

    // Send confirmation notification if rule was re-activated
    if (isActive === true && existingRule.isActive === false) {
      pushNotificationService.sendAutomationActiveNotification(req.userId, 'instagram', rule.keyword || 'AI').catch(err => 
        logger.warn('DM_AUTOMATION', 'Failed to send reactivation notification', { userId: req.userId, error: err.message })
      );
    }

    // ✅ ULTRA-SPEED: Invalidate rules cache for this user
    await cache.del(`rules:ig:${req.userId}`);

    res.status(200).json({
      success: true,
      data: {
        rule
      }
    });
  } catch (error) {
    logger.error('DM_AUTOMATION', 'Update rule error', { error: error.message, userId: req.userId, ruleId: req.params.id });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Delete DM Automation Rule
const deleteRule = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const existingRule = await prisma.dMAutomation.findUnique({
      where: { id }
    });

    if (!existingRule) {
      return res.status(404).json({
        error: 'Rule not found'
      });
    }

    if (existingRule.userId !== req.userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only delete your own rules'
      });
    }

    try {
      await prisma.dMAutomation.delete({
        where: { id }
      });
    } catch (deleteError) {
      // P2025 = Record to delete does not exist.
      // We ignore this as the desired outcome (record being gone) is still achieved.
      if (deleteError.code === 'P2025') {
        logger.info('DM_AUTOMATION', `Rule ${id} already deleted`);
      } else {
        logger.warn('DM_AUTOMATION', 'Delete rule db warning', { error: deleteError.message, ruleId: id });
      }
    }

    // ✅ ULTRA-SPEED: Invalidate rules cache for this user
    await cache.del(`rules:ig:${req.userId}`);

    res.status(200).json({
      success: true,
      message: 'Rule deleted successfully'
    });
  } catch (error) {
    logger.error('DM_AUTOMATION', 'Delete rule error', { error: error.message, userId: req.userId, ruleId: req.params.id });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  createRule,
  getRules,
  updateRule,
  deleteRule
};
