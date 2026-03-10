const instagramService = require('../services/instagramService');
const InstagramAccount = require('../../models/InstagramAccount');

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
    const InstagramAnalytics = require('../../models/InstagramAnalytics');
    let latestSnapshot = await InstagramAnalytics.findOne({ userId: req.userId }).sort({ date: -1 });

    // Auto-record snapshot if none today or if user wants "real-time" data
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // If no snapshot today, or we just want to ensure we have the absolute latest for "real-time"
    if (!latestSnapshot || latestSnapshot.date < startOfToday) {
      try {
        const stats = await instagramService.getAccountStats(account.instagramUserId, account.accessToken);

        // Fetch reach/impressions from top media for a "live" view if possible
        const media = await instagramService.getUserMedia(account.instagramUserId, account.accessToken);
        let totalImpressions = 0;
        let totalReach = 0;

        if (media && media.length > 0) {
          const topMedia = media.slice(0, 5);
          const insights = await Promise.all(topMedia.map(m => instagramService.getMediaInsights(m.id, account.accessToken, m.media_type)));
          totalImpressions = insights.reduce((sum, ins) => sum + (ins.impressions || 0), 0);
          totalReach = insights.reduce((sum, ins) => sum + (ins.reach || 0), 0);
        }

        latestSnapshot = await InstagramAnalytics.create({
          userId: req.userId,
          followers: stats.followers_count || 0,
          posts: stats.media_count || 0,
          impressions: totalImpressions,
          reach: totalReach,
          date: new Date()
        });
      } catch (e) {
        console.warn('Real-time snapshot creation failed:', e.message);
      }
    }

    // Get previous snapshot for comparison (e.g. yesterday)
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);

    const previousSnapshot = await InstagramAnalytics.findOne({
      userId: req.userId,
      date: { $lt: startOfToday }
    }).sort({ date: -1 });

    // Calculate growth
    const followerGrowth = (latestSnapshot && previousSnapshot)
      ? latestSnapshot.followers - previousSnapshot.followers
      : 0;

    // Get history (last 14 days)
    const history = await InstagramAnalytics.find({
      userId: req.userId,
      date: {
        gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      }
    }).sort({ date: 1 });

    res.status(200).json({
      success: true,
      data: {
        current: {
          followers: latestSnapshot?.followers || account.followers || 0,
          posts: latestSnapshot?.posts || account.mediaCount || 0,
          engagementRate: latestSnapshot?.followers > 0 ? (latestSnapshot.posts / latestSnapshot.followers) * 100 : 0,
        },
        growth: {
          followerGrowth,
          period: 'daily'
        },
        totalViews: latestSnapshot?.impressions || 0,
        followerHistory: history.map(snap => snap.followers),
        viewsHistory: history.map(snap => snap.impressions),
        weeklyData: history.map(snap => ({
          date: snap.date,
          followers: snap.followers,
          impressions: snap.impressions
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
    const decryptedToken = decryptToken(account.accessToken);

    const userData = await instagramBreaker.fire(
      `https://graph.instagram.com/me?fields=followers_count,follows_count,media_count&access_token=${decryptedToken}`
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

module.exports = {
  getDashboard,
  recordSnapshot,
  getMonthlyAnalytics
};
