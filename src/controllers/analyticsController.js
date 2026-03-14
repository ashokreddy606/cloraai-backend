const instagramService = require('../services/instagramService');
const InstagramAccount = require('../../models/InstagramAccount');
const InstagramAnalytics = require('../../models/InstagramAnalytics');
const prisma = require('../lib/prisma');
const { cache } = require('../utils/cache');
const { instagramBreaker } = require('./instagramController');
const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

console.log('--- analyticsController.js loaded (v3) ---');

// Get Analytics Dashboard
const getDashboard = async (req, res) => {
  try {
    const account = await InstagramAccount.findOne({ userId: req.userId });

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

    // Get latest snapshot from mongo
    let latestSnapshot = await InstagramAnalytics.findOne({ userId: req.userId }).sort({ date: -1 });

    // Auto-refresh impressions if snapshot is older than 1 hour for "real-time" feel
    // OR if forceRefresh is requested by user
    const forceRefresh = req.query.forceRefresh === 'true';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    let totalImpressions = 0;
    let totalReach = 0;

    if (!latestSnapshot || latestSnapshot.date < oneHourAgo || forceRefresh) {
      try {
        const stats = await instagramService.getAccountStats(account.instagramId, account.instagramAccessToken);

        // Try getting account-level insights first (more reliable for total views)
        const accountInsights = await instagramService.getAccountInsights(
          account.instagramId, 
          account.pageAccessToken || account.instagramAccessToken,
          'day'
        );

        totalImpressions = accountInsights.impressions || 0;
        totalReach = accountInsights.reach || 0;

        // Always fetch media insights for a "live" feel and aggregate them
        const media = await instagramService.getUserMedia(account.instagramId, account.instagramAccessToken);
        if (media && media.length > 0) {
          const topMedia = media.slice(0, 30);

          // Fetch video_views individually per VIDEO/REEL (the only reliable method)
          const videoItems = topMedia.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REELS');
          const videoViewCounts = await Promise.all(
            videoItems.map(m => instagramService.getVideoViewCount(m.id, account.instagramAccessToken))
          );
          const directVideoViews = videoViewCounts.reduce((sum, v) => sum + v, 0);
          console.log('[ANALYTICS] directVideoViews from individual fetches:', directVideoViews, 'videos checked:', videoItems.length);

          const insights = await Promise.all(topMedia.map(m => instagramService.getMediaInsights(m.id, account.instagramAccessToken, m.media_type)));
          
          const mediaImpressions = insights.reduce((sum, ins) => sum + (ins.impressions || 0), 0);
          const mediaReach = insights.reduce((sum, ins) => sum + (ins.reach || 0), 0);
          const mediaEngagement = insights.reduce((sum, ins) => sum + (ins.engagement || 0), 0);
          console.log('[ANALYTICS] mediaImpressions:', mediaImpressions, 'mediaReach:', mediaReach, 'accountInsights:', JSON.stringify(accountInsights));

          // Take the highest value across all sources
          totalImpressions = Math.max(totalImpressions, mediaImpressions, mediaEngagement, directVideoViews);
          totalReach = Math.max(totalReach, mediaReach);
        }

        // Create or Update snapshot
        latestSnapshot = await InstagramAnalytics.create({
          userId: req.userId,
          followers: stats.followers_count || 0,
          posts: stats.media_count || 0,
          following: stats.follows_count || 0,
          impressions: totalImpressions,
          reach: totalReach,
          date: new Date()
        });
      } catch (e) {
        console.warn('Snapshot refresh failed:', e.message);
      }
    }

    // ALWAYS fetch live summary stats for "real-time" dashboard feel
    let liveStats = { followers_count: 0, follows_count: 0, media_count: 0 };
    try {
      liveStats = await instagramService.getAccountStats(account.instagramId, account.instagramAccessToken);
    } catch (e) {
      console.warn('Live stats fetch failed, falling back to snapshot:', e.message);
      liveStats = {
        followers_count: latestSnapshot?.followers || 0,
        follows_count: latestSnapshot?.following || 0,
        media_count: latestSnapshot?.posts || 0
      };
    }

    // Get previous snapshot for comparison (e.g. yesterday)
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = new Date(yesterday);
    startOfYesterday.setHours(0, 0, 0, 0);

    const previousSnapshot = await InstagramAnalytics.findOne({
      userId: req.userId,
      date: { $lt: startOfToday, $gte: startOfYesterday }
    }).sort({ date: -1 }) || await InstagramAnalytics.findOne({
      userId: req.userId,
      date: { $lt: startOfToday }
    }).sort({ date: -1 });

    // Calculate growth
    const followerGrowth = (liveStats.followers_count && previousSnapshot)
      ? liveStats.followers_count - previousSnapshot.followers
      : 0;

    // Growth last 30 days
    const thirtyDaysAgo = new Date(startOfToday);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const snapshot30d = await InstagramAnalytics.findOne({
      userId: req.userId,
      date: { $gte: thirtyDaysAgo }
    }).sort({ date: 1 });

    const followerGrowth30d = (liveStats.followers_count && snapshot30d)
      ? liveStats.followers_count - snapshot30d.followers
      : 0;

    // Get history (last 30 days)
    const history = await InstagramAnalytics.find({
      userId: req.userId,
      date: {
        $gte: thirtyDaysAgo
      }
    }).sort({ date: 1 });

    // Real-time unfollow calculation (difference between snapshots)
    const unfollowed = previousSnapshot && liveStats ? Math.max(0, previousSnapshot.followers - liveStats.followers_count) : 0;

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
    const mediaInsights = await InstagramAnalytics.find({
      userId: req.userId,
      date: { $gte: thirtyDaysAgo }
    });
    const views30d = mediaInsights.reduce((sum, m) => sum + (m.impressions || 0), 0);

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
          growthPercentage: previousSnapshot?.followers > 0 ? ((followers - previousSnapshot.followers) / previousSnapshot.followers) * 100 : 0,
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
        totalViews: (latestSnapshot?.impressions || totalImpressions) || 0,
        followerHistory: history.map(snap => snap.followers),
        viewsHistory: history.map(snap => snap.impressions),
        activityHistory: history.map(snap => snap.reach || 0),
        automationActivity,
        latestInteractions,
        unfollowedHistory: history.map(snap => snap.unfollowed || 0), // Future-proofing
        weeklyData: history.map(snap => ({
          date: snap.date,
          followers: snap.followers,
          impressions: snap.impressions,
          reach: snap.reach || 0,
          unfollowed: snap.unfollowed || 0
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

    const { decryptToken } = require('../utils/cryptoUtils');
    const decryptedToken = decryptToken(account.instagramAccessToken);

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
    const account = await InstagramAccount.findOne({ userId: req.userId });
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
      results.accountInsights = await instagramService.getAccountInsights(
        account.instagramId,
        account.pageAccessToken || account.instagramAccessToken,
        'day'
      );
    } catch (e) {
      results.accountInsightsError = e.response?.data || e.message;
    }

    // 3. Media list
    let media = [];
    try {
      media = await instagramService.getUserMedia(account.instagramId, account.instagramAccessToken);
      results.mediaCount = media.length;
      results.mediaTypes = media.map(m => m.media_type);
    } catch (e) {
      results.mediaError = e.response?.data || e.message;
    }

    // 4. Per-video video_views
    const videoItems = media.filter(m => m.media_type === 'VIDEO' || m.media_type === 'REELS').slice(0, 5);
    results.videoViewChecks = await Promise.all(videoItems.map(async (m) => {
      const views = await instagramService.getVideoViewCount(m.id, account.instagramAccessToken);
      return { id: m.id, media_type: m.media_type, video_views: views };
    }));

    // 5. First video media insights
    if (videoItems.length > 0) {
      try {
        results.firstVideoInsights = await instagramService.getMediaInsights(
          videoItems[0].id, account.instagramAccessToken, videoItems[0].media_type
        );
      } catch (e) {
        results.firstVideoInsightsError = e.response?.data || e.message;
      }
    }

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
