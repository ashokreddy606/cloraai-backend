const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { cache } = require('../utils/cache');
const { decrypt } = require('../utils/cryptoUtils');
const { instagramBreaker = {} } = require('./instagramController');
const { enqueueJob, analyticsQueue } = require('../utils/queue');
const instagramService = require('../services/instagramService');
const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

logger.info('ANALYTICS', 'Analytics Controller initialized');

// Get Analytics Dashboard
const getDashboard = async (req, res) => {
  const cacheKey = `ig_dashboard_${req.userId}`;
  try {
    const cachedData = await cache.get(cacheKey);
    if (cachedData && req.query.forceRefresh !== 'true') {
      logger.info('ANALYTICS', 'Returning cached dashboard', { userId: req.userId });
      return res.status(200).json(cachedData);
    }

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

    const isStale = !latestSnapshot || snapshotDate < oneHourAgo || forceRefresh;

    if (isStale) {
      logger.info('ANALYTICS', `Snapshot stale/force for ${req.userId}. Dispatching background refresh.`);
      const decryptedToken = decrypt(account.instagramAccessToken);
      
      enqueueJob(analyticsQueue, 'refresh-analytics', { 
        userId: req.userId,
        instagramId: account.instagramId,
        accessToken: decryptedToken,
        syncType: forceRefresh ? 'deep' : 'fast'
      }, {
        jobId: `refresh-${req.userId}` // Ensure only one active refresh per user
      }).catch(err => logger.error('ANALYTICS:ENQUEUE_FAIL', err.message));
    }

    let liveStats = null;
    let fallbackToSnapshot = false;

    try {
      const decryptedToken = decrypt(account.instagramAccessToken);
      if (decryptedToken) {
        const stats = await instagramService.getAccountStats(account.instagramId, decryptedToken);
        if (stats && typeof stats.followers_count === 'number') {
           liveStats = stats;
        } else {
           throw new Error('Invalid stats received from Meta');
        }
      } else {
        throw new Error('Encryption error: Token unreadable');
      }
    } catch (e) {
      logger.warn('ANALYTICS', `Live stats fetch failed for ${req.userId}, falling back to snapshot: ${e.message}`);
      fallbackToSnapshot = true;
      liveStats = {
        followers_count: latestSnapshot?.followers ?? 0,
        follows_count: latestSnapshot?.following ?? 0,
        media_count: latestSnapshot?.mediaCount ?? 0
      };
    }

    // If we have NO data at all (no snapshot, no live stats), return 503 so frontend knows to retry later
    if (fallbackToSnapshot && !latestSnapshot && liveStats.followers_count === 0 && account.isConnected) {
       return res.status(503).json({
         success: false,
         error: 'Meta API Unavailable',
         message: 'Real-time data could not be fetched and no cached snapshots exist. Please try again in 1 minute.',
         isRefreshing: true
       });
    }

    // Improved Previous Snapshot Lookup (find most recent snapshot before today)
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = new Date(yesterday);
    startOfYesterday.setHours(0, 0, 0, 0);

    const previousSnapshot = await prisma.analyticsSnapshot.findFirst({
      where: {
        userId: req.userId,
        snapshotDate: { lt: startOfToday }
      },
      orderBy: { snapshotDate: 'desc' }
    });

    // Calculate growth (Today)
    let followerGrowth = 0;
    if (liveStats.followers_count && previousSnapshot) {
        followerGrowth = liveStats.followers_count - (previousSnapshot.followers ?? 0);
    } else if (liveStats.followers_count) {
        // New user baseline: check if we have an early snapshot from today
        const firstToday = await prisma.analyticsSnapshot.findFirst({
            where: { userId: req.userId, snapshotDate: { gte: startOfToday } },
            orderBy: { snapshotDate: 'asc' }
        });
        if (firstToday && latestSnapshot && firstToday.id !== latestSnapshot.id) {
            followerGrowth = liveStats.followers_count - (firstToday.followers ?? 0);
        }
    }

    // Growth last 30 days (Find earliest snapshot in history to provide baseline)
    const thirtyDaysAgo = new Date(startOfToday);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const snapshot30d = await prisma.analyticsSnapshot.findFirst({
      where: {
        userId: req.userId,
        snapshotDate: { gte: thirtyDaysAgo }
      },
      orderBy: { snapshotDate: 'asc' }
    }) || await prisma.analyticsSnapshot.findFirst({
      where: { userId: req.userId },
      orderBy: { snapshotDate: 'asc' }
    });

    const followerGrowth30d = (liveStats.followers_count && snapshot30d && snapshot30d.id !== latestSnapshot?.id)
      ? liveStats.followers_count - (snapshot30d.followers ?? 0)
      : 0;

    // Get history (last 30 days) for internal tracking/charting
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

    // Automation Activity (Last 30 days) - Single query optimization
    const thirtyDaysAgoStart = new Date(startOfToday);
    thirtyDaysAgoStart.setDate(thirtyDaysAgoStart.getDate() - 29);
    thirtyDaysAgoStart.setHours(0, 0, 0, 0);

    const rawInteractions = await prisma.dmInteraction.findMany({
      where: {
        userId: req.userId,
        status: 'sent',
        createdAt: { gte: thirtyDaysAgoStart }
      },
      select: { createdAt: true }
    });

    const activityMap = new Map();
    rawInteractions.forEach(interaction => {
        const dateStr = new Date(interaction.createdAt.getTime() - interaction.createdAt.getTimezoneOffset() * 60000).toISOString().split('T')[0];
        activityMap.set(dateStr, (activityMap.get(dateStr) || 0) + 1);
    });

    const automationActivity = Array.from({ length: 30 }).map((_, i) => {
        const d = new Date(startOfToday);
        d.setDate(d.getDate() - (29 - i));
        const dateStr = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
        return activityMap.get(dateStr) || 0;
    });

    // Total messages handled (any interaction status)
    const totalMessagesHandled = await prisma.dmInteraction.count({
      where: { userId: req.userId }
    });

    // Fetch total comments, likes and reels count from media list (ensure decrypted token is used)
    let totalComments = 0;
    let totalLikes = 0;
    let reelsCount = 0;
    try {
      const decryptedToken = decrypt(account.instagramAccessToken);
      const media = await instagramService.getUserMedia(account.instagramId, decryptedToken || account.instagramAccessToken);
      if (media && media.length > 0) {
        totalComments = media.reduce((sum, m) => sum + (m.comments_count || 0), 0);
        totalLikes = media.reduce((sum, m) => sum + (m.like_count || 0), 0);
        reelsCount = media.filter(m => m.media_type === 'VIDEO').length;
      }
    } catch (e) {
      console.warn('Media-based stats aggregation failed:', e.message);
    }
    const totalEngagements = totalComments + totalLikes;

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

    const finalResponse = {
      success: true,
      isRefreshing: isStale,
      isFallback: fallbackToSnapshot,
      lastUpdated: latestSnapshot?.snapshotDate || null,
      data: {
        current: {
          followers,
          posts,
          following,
          reels: reelsCount,
          engagementRate: followers > 0 ? (totalEngagements / followers) * 100 : 0,
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
          views30d, // Prioritise 30-day sum for the main dashboard views stat
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
    };

    // ── Save to Cache ──
    await cache.set(cacheKey, finalResponse, 300);

    res.status(200).json(finalResponse);
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

    let totalEngagements = 0;
    try {
        const media = await instagramService.getUserMedia(account.instagramId, decryptedToken);
        if (media && media.length > 0) {
            totalEngagements = media.reduce((sum, m) => sum + (m.like_count || 0) + (m.comments_count || 0), 0);
        }
    } catch(e) {
        logger.warn('ANALYTICS', 'Could not fetch media for engagement calculation', { error: e.message });
    }

    const engagementRate = followers > 0 ? (totalEngagements / followers) * 100 : 0;

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
