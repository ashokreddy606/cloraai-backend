const instagramService = require('../services/instagramService');
// const InstagramAccount = require('../../models/InstagramAccount'); // Deleted in Prisma migration
// const InstagramAnalytics = require('../../models/InstagramAnalytics'); // Deleted in Prisma migration
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { cache } = require('../utils/cache');
const { decrypt } = require('../utils/cryptoUtils');
const { instagramBreaker } = require('./instagramController');
const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

logger.info('ANALYTICS', 'Analytics Controller initialized');

// Get Analytics Dashboard
const getDashboard = async (req, res) => {
  try {
    const account = await prisma.instagramAccount.findUnique({ where: { userId: req.userId } });

    if (!account) {
      return res.status(200).json({
        success: true,
        data: {
          current: {
            followers: 0,
            following: 0,
            mediaCount: 0,
            engagementRate: 0,
            topPostEngagement: 0
          },
          growth: {
            followerGrowth: 0,
            period: 'daily'
          },
          totalViews: 0,
          followerHistory: [],
          viewsHistory: [],
          weeklyData: []
        }
      });
    }

    // Get latest snapshot from prisma
    let latestSnapshot = await prisma.analyticsSnapshot.findFirst({ 
      where: { userId: req.userId },
      orderBy: { snapshotDate: 'desc' } 
    });

    // Auto-refresh impressions if snapshot is older than 1 hour for "real-time" feel
    // OR if forceRefresh is requested by user
    const forceRefresh = req.query.forceRefresh === 'true';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    let totalImpressions = 0;
    let totalReach = 0;

    const snapshotDate = latestSnapshot?.snapshotDate ? new Date(latestSnapshot.snapshotDate) : new Date(0);

    if (!latestSnapshot || snapshotDate < oneHourAgo || forceRefresh) {
      try {
        const decryptedToken = decrypt(account.instagramAccessToken);
        if (!decryptedToken) {
          logger.warn('ANALYTICS', `Skipping stats fetch: Unable to decrypt token for user ${req.userId}`);
          throw new Error('Token decryption failed');
        }

        const stats = await instagramService.getAccountStats(account.instagramId, decryptedToken);

        // Decrypt page token if present, otherwise use decrypted user token
        const pToken = account.pageAccessToken ? (decrypt(account.pageAccessToken) || decryptedToken) : decryptedToken;

        // Try getting account-level insights first (more reliable for total views)
        const accountInsights = await instagramService.getAccountInsights(
          account.instagramId, 
          pToken,
          'day'
        );

        // EXTRA: Fetch 28-day insights to capture long-term views (matches user screenshot "41 views in last 30 days")
        const accountInsights30d = await instagramService.getAccountInsights(
          account.instagramId,
          pToken,
          'days_28'
        );

        const accountDay = accountInsights.reach || 0;
        const account28d = accountInsights30d.reach || 0;

        totalReach = Math.max(accountDay, account28d);
        totalImpressions = Math.max(accountInsights.impressions || 0, accountInsights30d.impressions || 0, totalReach);

        // Always fetch media insights for a "live" feel and aggregate them
        const media = await instagramService.getUserMedia(account.instagramId, decryptedToken);
        let totalMediaReach = 0;
        let totalMediaImpressions = 0;
        let totalPlays = 0;
        let totalInteractions = 0;

        if (media && media.length > 0) {
          const topMedia = media.slice(0, 30);

          // Fetch plays independently (direct field) and insights
          const videoItems = topMedia.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REELS');
          const videoPlayCounts = await Promise.all(
            videoItems.map(m => instagramService.getVideoViewCount(m.id, decryptedToken))
          );
          const directPlays = videoPlayCounts.reduce((sum, v) => sum + v, 0);

          const insights = await Promise.all(topMedia.map(m => instagramService.getMediaInsights(m.id, decryptedToken, m.media_type)));
          
          totalMediaImpressions = insights.reduce((sum, ins) => sum + (ins.impressions || 0), 0);
          totalPlays = insights.reduce((sum, ins) => sum + (ins.plays || 0), 0) + directPlays;
          totalMediaReach = insights.reduce((sum, ins) => sum + (ins.reach || 0), 0);
          totalInteractions = insights.reduce((sum, ins) => sum + (ins.total_interactions || 0), 0);
          
          logger.info('ANALYTICS', `Final Aggregation: Account[${accountDay}/${account28d}] Media[${totalMediaReach}/${totalMediaImpressions}/${totalPlays}] Interactions[${totalInteractions}]`);

          // Take the highest value across relevant sources to be robust
          totalImpressions = Math.max(totalImpressions, totalMediaImpressions, totalPlays);
          totalReach = Math.max(totalReach, totalMediaReach);
        }

        // Create or Update snapshot
        latestSnapshot = await prisma.analyticsSnapshot.create({
          data: {
            userId: req.userId,
            followers: stats.followers_count || 0,
            posts: stats.media_count || 0,
            following: stats.follows_count || 0,
            impressions: totalImpressions,
            reach: totalReach,
            snapshotDate: new Date()
          }
        });
      } catch (e) {
        console.warn('Snapshot refresh failed:', e.message);
      }
    }

    // ALWAYS fetch live summary stats for "real-time" dashboard feel
    let liveStats = { followers_count: 0, follows_count: 0, media_count: 0 };
    try {
      const decryptedToken = decrypt(account.instagramAccessToken);
      if (decryptedToken) {
        liveStats = await instagramService.getAccountStats(account.instagramId, decryptedToken);
      } else {
        throw new Error('Encryption error');
      }
    } catch (e) {
      console.warn('Live stats fetch failed, falling back to snapshot:', e.message);
      liveStats = {
        followers_count: latestSnapshot?.followers ?? 0,
        follows_count: latestSnapshot?.following ?? 0,
        media_count: latestSnapshot?.mediaCount ?? 0
      };
    }

    // Get previous snapshot for comparison (e.g. yesterday)
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = new Date(yesterday);
    startOfYesterday.setHours(0, 0, 0, 0);

    const previousSnapshot = await prisma.analyticsSnapshot.findFirst({
      where: {
        userId: req.userId,
        snapshotDate: { lt: startOfToday, gte: startOfYesterday }
      },
      orderBy: { snapshotDate: 'desc' }
    }) || await prisma.analyticsSnapshot.findFirst({
      where: {
        userId: req.userId,
        snapshotDate: { lt: startOfToday }
      },
      orderBy: { snapshotDate: 'desc' }
    });

    // Calculate growth
    const followerGrowth = (liveStats.followers_count && previousSnapshot)
      ? liveStats.followers_count - (previousSnapshot.followers ?? 0)
      : 0;

    // Growth last 30 days
    const thirtyDaysAgo = new Date(startOfToday);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const snapshot30d = await prisma.analyticsSnapshot.findFirst({
      where: {
        userId: req.userId,
        snapshotDate: { gte: thirtyDaysAgo }
      },
      orderBy: { snapshotDate: 'asc' }
    });

    const followerGrowth30d = (liveStats.followers_count && snapshot30d)
      ? liveStats.followers_count - (snapshot30d.followers ?? 0)
      : 0;

    // Get history (last 30 days)
    const history = await prisma.analyticsSnapshot.findMany({
      where: {
        userId: req.userId,
        snapshotDate: {
          gte: thirtyDaysAgo
        }
      },
      orderBy: { snapshotDate: 'asc' }
    });

    // Real-time unfollow calculation (difference between snapshots)
    const unfollowed = previousSnapshot && liveStats ? Math.max(0, (previousSnapshot.followers ?? 0) - liveStats.followers_count) : 0;

    // Fetch automation stats
    const automationRules = await prisma.dMAutomation.findMany({
      where: { userId: req.userId }
    });
    const anyActive = automationRules.some(r => r.isActive);

    // Total automated replies sent (sum of interactions)
    const totalRepliesSent = await prisma.dmInteraction.count({
      where: { userId: req.userId, status: 'sent' }
    });

    // Replies sent today
    const repliesSentToday = await prisma.dmInteraction.count({
      where: {
        userId: req.userId,
        status: 'sent',
        createdAt: { gte: startOfToday }
      }
    });

    // Automation Activity (Last 30 days)
    const automationActivity = await Promise.all(
      Array.from({ length: 30 }).map(async (_, i) => {
        const d = new Date(startOfToday);
        d.setDate(d.getDate() - (29 - i));
        const start = new Date(d);
        start.setHours(0, 0, 0, 0);
        const end = new Date(d);
        end.setHours(23, 59, 59, 999);
        
        return prisma.dmInteraction.count({
          where: {
            userId: req.userId,
            status: 'sent',
            createdAt: { gte: start, lte: end }
          }
        });
      })
    );

    // Total messages handled (any interaction status)
    const totalMessagesHandled = await prisma.dmInteraction.count({
      where: { userId: req.userId }
    });

    // Fetch total comments and reels count from media list
    let totalComments = 0;
    let reelsCount = 0;
    try {
      const media = await instagramService.getUserMedia(account.instagramId, account.instagramAccessToken);
      if (media && media.length > 0) {
        totalComments = media.reduce((sum, m) => sum + (m.comments_count || 0), 0);
        reelsCount = media.filter(m => m.media_type === 'VIDEO').length;
      }
    } catch (e) {
      console.warn('Media-based stats aggregation failed:', e.message);
    }

    // 30-day views
    const mediaInsights = await prisma.analyticsSnapshot.findMany({
      where: {
        userId: req.userId,
        snapshotDate: { gte: thirtyDaysAgo }
      }
    });
    const views30d = mediaInsights.reduce((sum, m) => sum + (m.impressions ?? 0), 0);

    // Fetch latest 5 automation interactions for real-time feed
    const latestInteractions = await prisma.dmInteraction.findMany({
      where: { userId: req.userId, status: 'sent' },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    // Final mapping
    const followers = liveStats.followers_count;
    const posts = liveStats.media_count;
    const following = liveStats.follows_count;

    res.status(200).json({
      success: true,
      data: {
        current: {
          followers,
          posts,
          following,
          reels: reelsCount,
          engagementRate: followers > 0 ? (posts / followers) * 100 : 0,
          username: account.instagramUsername || account.username || '',
          profileImage: account.profileImage || '',
        },
        growth: {
          followerGrowth,
          followerGrowth30d,
          growthPercentage: (previousSnapshot?.followers ?? 0) > 0 ? ((followers - (previousSnapshot.followers ?? 0)) / (previousSnapshot.followers ?? 0)) * 100 : 0,
          period: 'daily',
          unfollowed,
        },
        automation: {
          isActive: anyActive,
          repliesSent: totalRepliesSent,
          repliesSentToday,
          totalMessagesHandled,
          totalComments,
        },
        views: {
          views30d,
        },
        totalViews: Math.max(
          latestSnapshot?.impressions ?? 0,
          latestSnapshot?.reach ?? 0,
          totalImpressions,
          totalReach
        ),
        followerHistory: history.map(snap => snap.followers ?? 0),
        viewsHistory: history.map(snap => Math.max(snap.impressions ?? 0, snap.reach ?? 0)),
        activityHistory: history.map(snap => snap.reach ?? 0),
        automationActivity,
        latestInteractions,
        unfollowedHistory: history.map(snap => snap.unfollowed ?? 0), // Future-proofing
        weeklyData: history.map(snap => ({
          date: snap.snapshotDate,
          followers: snap.followers ?? 0,
          impressions: snap.impressions ?? 0,
          reach: snap.reach ?? 0,
          unfollowed: snap.unfollowed ?? 0
        }))
      }
    });
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({
      error: 'Failed to fetch analytics',
      message: error.message
    });
  }
};

// Record Analytics Snapshot securely Server-Side
const recordSnapshot = async (req, res) => {
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { userId: req.userId }
    });

    if (!account || !account.isConnected) {
      return res.status(400).json({ error: 'Instagram not connected' });
    }

    const { decrypt } = require('../utils/cryptoUtils');
    const decryptedToken = decrypt(account.instagramAccessToken);
    
    if (!decryptedToken) {
        return res.status(401).json({ error: 'Instagram token unreadable. Please reconnect.' });
    }

    const userData = await instagramBreaker.fire(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${account.instagramId}?fields=followers_count,follows_count,media_count&access_token=${decryptedToken}`
    );

    if (userData.fallback) {
      return res.status(503).json({ error: 'Instagram API Unavailable', message: 'Instagram API is down' });
    }

    const followers = userData.data.followers_count || 0;
    const following = userData.data.follows_count || 0;
    const mediaCount = userData.data.media_count || 0;

    // Server-side calculation prevents frontend spoofing. 
    // This is basic engagement; deep logic uses pages_read_engagement later.
    const engagementRate = followers > 0 ? (mediaCount / followers) * 100 : 0;

    const snapshot = await prisma.analyticsSnapshot.create({
      data: {
        userId: req.userId,
        followers,
        following,
        mediaCount,
        engagementRate: engagementRate,
        topPostEngagement: 0,
        snapshotDate: new Date()
      }
    });

    await cache.clearUserCache(req.userId);

    res.status(201).json({
      success: true,
      data: { snapshot }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to record snapshot',
      message: error.message
    });
  }
};

// Get Monthly Analytics
const getMonthlyAnalytics = async (req, res) => {
  try {
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    const snapshots = await prisma.analyticsSnapshot.findMany({
      where: {
        userId: req.userId,
        snapshotDate: { gte: monthAgo }
      },
      orderBy: { snapshotDate: 'asc' }
    });

    const avgEngagement = snapshots.reduce((sum, s) => sum + s.engagementRate, 0) / snapshots.length || 0;

    res.status(200).json({
      success: true,
      data: {
        period: 'monthly',
        dataPoints: snapshots.length,
        averageEngagement: avgEngagement,
        snapshots
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch monthly analytics',
      message: error.message
    });
  }
};

// Debug endpoint - shows raw API results to diagnose view count issues
const debugViews = async (req, res) => {
  try {
    const account = await prisma.instagramAccount.findUnique({ where: { userId: req.userId } });
    if (!account) return res.status(404).json({ error: 'No Instagram account found' });

    const results = {};

    // 1. Account stats
    try {
      results.accountStats = await instagramService.getAccountStats(account.instagramId, account.instagramAccessToken);
    } catch (e) {
      results.accountStatsError = e.response?.data || e.message;
    }

    // 2. Account insights
    try {
      results.accountInsightsDay = await instagramService.getAccountInsights(
        account.instagramId,
        account.pageAccessToken || account.instagramAccessToken,
        'day'
      );
      results.accountInsights28d = await instagramService.getAccountInsights(
        account.instagramId,
        account.pageAccessToken || account.instagramAccessToken,
        'days_28'
      );
    } catch (e) {
      results.accountInsightsError = e.response?.data || e.message;
    }
    
    // 3. Media list (top 5 for debug)
    let media = [];
    try {
      media = await instagramService.getUserMedia(account.instagramId, account.instagramAccessToken);
      results.mediaCount = media.length;
      results.topMedia = media.slice(0, 5).map(m => ({
        id: m.id,
        type: m.media_type,
        timestamp: m.timestamp
      }));
    } catch (e) {
      results.mediaError = e.response?.data || e.message;
    }

    // Per-video video_views direct field & Reel plays via insights
    const videoItems = media.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REELS').slice(0, 5);
    results.videoChecks = await Promise.all(videoItems.map(async (m) => {
      const insights = await instagramService.getMediaInsights(m.id, account.instagramAccessToken, m.media_type);
      const directPlays = await instagramService.getVideoViewCount(m.id, account.instagramAccessToken);
      return { 
        id: m.id, 
        type: m.media_type, 
        direct_plays: directPlays,
        plays: insights.plays || 0,
        impressions: insights.impressions || 0,
        reach: insights.reach || 0,
        total_interactions: insights.total_interactions || 0,
        raw_insights: insights
      };
    }));

    res.status(200).json({ success: true, debug: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getDashboard,
  recordSnapshot,
  getMonthlyAnalytics,
  debugViews
};
