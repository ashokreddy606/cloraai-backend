const prisma = require('../lib/prisma');
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');
const axios = require('axios');

const instagramBreaker = createBreaker(async (url) => {
  return await axios.get(url);
}, 'Instagram');

// Get Analytics Dashboard
const getDashboard = async (req, res) => {
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { userId: req.userId }
    });

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
          weeklyData: []
        }
      });
    }

    // Get latest analytics
    let latestSnapshot = await prisma.analyticsSnapshot.findFirst({
      where: { userId: req.userId },
      orderBy: { snapshotDate: 'desc' }
    });

    // Auto-record snapshot if none today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    if (!latestSnapshot || latestSnapshot.snapshotDate < startOfToday) {
      if (account.isConnected) {
        try {
          const { decryptToken } = require('../utils/cryptoUtils');
          const decryptedToken = decryptToken(account.accessToken);

          const userData = await instagramBreaker.fire(`https://graph.instagram.com/me?fields=followers_count,follows_count,media_count&access_token=${decryptedToken}`);

          if (userData.fallback) throw new Error("Fallback response");

          const followers = userData.data.followers_count || account.followers;
          const following = userData.data.follows_count || account.following;
          const mediaCount = userData.data.media_count || account.mediaCount;
          const engagementRate = followers > 0 ? (mediaCount / followers) * 100 : 0;

          latestSnapshot = await prisma.analyticsSnapshot.create({
            data: {
              userId: req.userId,
              followers,
              following,
              mediaCount,
              engagementRate,
              topPostEngagement: 0,
              snapshotDate: new Date()
            }
          });
        } catch (e) {
          console.warn('Silent snapshot creation failed:', e.message);
        }
      }
    }

    // Get previous snapshot for comparison
    const previousSnapshot = await prisma.analyticsSnapshot.findFirst({
      where: { userId: req.userId },
      orderBy: { snapshotDate: 'desc' },
      skip: 1
    });

    // Calculate growth
    const followerGrowth = latestSnapshot && previousSnapshot
      ? latestSnapshot.followers - previousSnapshot.followers
      : 0;

    // Get weekly data
    const weeklyData = await prisma.analyticsSnapshot.findMany({
      where: {
        userId: req.userId,
        snapshotDate: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        }
      },
      orderBy: { snapshotDate: 'asc' }
    });

    res.status(200).json({
      success: true,
      data: {
        current: {
          followers: latestSnapshot?.followers || account.followers,
          following: latestSnapshot?.following || account.following,
          mediaCount: latestSnapshot?.mediaCount || account.mediaCount,
          engagementRate: latestSnapshot?.engagementRate || 0,
          topPostEngagement: latestSnapshot?.topPostEngagement || 0
        },
        growth: {
          followerGrowth,
          period: 'daily'
        },
        weeklyData: weeklyData.map(snap => ({
          date: snap.snapshotDate,
          followers: snap.followers,
          engagement: snap.engagementRate
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
