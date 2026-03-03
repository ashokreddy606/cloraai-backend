const { PrismaClient } = require('@prisma/client');
const { appConfig } = require('../config');

const prisma = new PrismaClient();

// Create DM Automation Rule
const createRule = async (req, res) => {
  try {
    const { keyword, autoReplyMessage } = req.body;

    if (!appConfig.featureFlags.autoDMEnabled) {
      return res.status(403).json({
        error: 'Feature Disabled',
        message: 'DM Automation has been temporarily disabled by the administrator.'
      });
    }

    if (!keyword || !autoReplyMessage) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'keyword and autoReplyMessage are required'
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

      if (ruleCount >= 3) {
        return res.status(403).json({
          error: 'Free plan limit reached',
          message: 'Free plan allows 3 DM automation rules. Upgrade to Pro for unlimited rules.',
          code: 'PLAN_LIMIT',
          limit: 3,
          used: ruleCount,
        });
      }
    }

    const rule = await prisma.dMAutomation.create({
      data: {
        userId: req.userId,
        keyword,
        autoReplyMessage,
        isActive: true
      }
    });

    res.status(201).json({
      success: true,
      data: {
        rule
      }
    });
  } catch (error) {
    console.error('Create rule error:', error);
    res.status(500).json({
      error: 'Failed to create rule',
      message: error.message
    });
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
    res.status(500).json({
      error: 'Failed to fetch rules',
      message: error.message
    });
  }
};

// Update DM Automation Rule
const updateRule = async (req, res) => {
  try {
    const { id } = req.params;
    const { keyword, autoReplyMessage, isActive } = req.body;

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
        ...(keyword && { keyword }),
        ...(autoReplyMessage && { autoReplyMessage }),
        ...(isActive !== undefined && { isActive })
      }
    });

    res.status(200).json({
      success: true,
      data: {
        rule
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update rule',
      message: error.message
    });
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

    await prisma.dMAutomation.delete({
      where: { id }
    });

    res.status(200).json({
      success: true,
      message: 'Rule deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to delete rule',
      message: error.message
    });
  }
};

module.exports = {
  createRule,
  getRules,
  updateRule,
  deleteRule
};
