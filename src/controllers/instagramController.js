const axios = require('axios');
const { encryptToken, decryptToken } = require('../utils/cryptoUtils');
const prisma = require('../lib/prisma');
const instagramService = require('../services/instagramService');
const InstagramAccount = require('../../models/InstagramAccount');
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');

const instagramBreaker = createBreaker(async (url) => {
  return await axios.get(url);
}, 'Instagram');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v18.0';
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;

// 1. Initiate Instagram OAuth (Redirect to Meta)
const initiateAuth = (req, res) => {
  try {
    const APP_ID = process.env.INSTAGRAM_APP_ID;
    const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;
    const scope = 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement';

    // Use state for CSRF protection
    const state = Buffer.from(JSON.stringify({ userId: req.userId })).toString('base64');

    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code&state=${state}`;

    res.status(200).json({
      success: true,
      data: { authUrl }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
};

// 2. Handle OAuth Callback
const handleOAuthCallback = async (req, res) => {
  const { code } = req.body;
  const userId = req.userId;

  if (!code) return res.status(400).json({ error: 'Code is required' });

  try {
    // 1. Exchange code for long-lived token
    const { accessToken, expiresIn, instagramUserId } = await instagramService.exchangeCodeForToken(code);

    // 2. Discover Instagram Business Account linked to FB Pages
    const igBusinessId = await instagramService.getBusinessAccount(accessToken);

    // 3. Save/Update Mongoose InstagramAccount
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

    await InstagramAccount.findOneAndUpdate(
      { userId },
      {
        instagramUserId: igBusinessId,
        accessToken,
        tokenExpiresAt: expiresAt,
        connectedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      message: 'Instagram account connected successfully!'
    });
  } catch (error) {
    res.status(500).json({ error: 'OAuth failed', message: error.message });
  }
};

// Fetch Instagram Account Details
const getAccountDetails = async (req, res) => {
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { userId: req.userId }
    });

    if (!account || !account.isConnected) {
      return res.status(200).json({
        success: true,
        data: {
          account: null,
          isConnected: false
        }
      });
    }

    // Decrypt the token securely before making API calls
    const decryptedToken = decryptToken(account.accessToken);

    // Fetch latest data from Instagram API
    const userData = await instagramBreaker.fire(
      `https://graph.instagram.com/me?fields=id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website&access_token=${decryptedToken}`
    );

    if (userData.fallback) {
      return res.status(503).json({
        error: 'Instagram API Unavailable',
        message: 'Unable to fetch account details right now.'
      });
    }

    // Update database
    await prisma.instagramAccount.update({
      where: { userId: req.userId },
      data: {
        followers: userData.data.followers_count || account.followers,
        following: userData.data.follows_count || account.following,
        mediaCount: userData.data.media_count || account.mediaCount,
        lastSyncedAt: new Date()
      }
    });

    res.status(200).json({
      success: true,
      data: {
        account: {
          username: userData.data.username,
          followers: userData.data.followers_count,
          following: userData.data.follows_count,
          mediaCount: userData.data.media_count,
          biography: userData.data.biography,
          website: userData.data.website,
          profileImage: userData.data.profile_picture_url
        }
      }
    });
  } catch (error) {
    console.error('Get account details error:', error);
    res.status(500).json({
      error: 'Failed to fetch account details',
      message: error.message
    });
  }
};

// Disconnect Instagram Account
const disconnectAccount = async (req, res) => {
  try {
    await prisma.instagramAccount.delete({
      where: { userId: req.userId }
    });

    res.status(200).json({
      success: true,
      message: 'Instagram account disconnected successfully and token removed'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to disconnect account',
      message: error.message
    });
  }
};

// Fetch Instagram Account Stats (requested with Redis caching)
const getStats = async (req, res) => {
  const cacheKey = `instagram_stats_${req.userId}`;

  try {
    const cachedData = await cache.get(cacheKey);
    if (cachedData) return res.status(200).json({ success: true, data: cachedData });

    const account = await InstagramAccount.findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const stats = await instagramService.getAccountStats(account.instagramUserId, account.accessToken);

    await cache.set(cacheKey, stats, 600); // 10 min TTL

    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Instagram stats', message: error.message });
  }
};

// Fetch Instagram Recent Posts (requested with enriched insights and Redis caching)
const getPosts = async (req, res) => {
  const cacheKey = `instagram_media_enriched_${req.userId}`;

  try {
    const cachedData = await cache.get(cacheKey);
    if (cachedData) return res.status(200).json({ success: true, data: cachedData });

    const account = await InstagramAccount.findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const posts = await instagramService.getUserMedia(account.instagramUserId, account.accessToken);

    // Enrich top 10 posts with reach/impressions
    const enrichedPosts = await Promise.all(posts.slice(0, 10).map(async (post) => {
      try {
        const insights = await instagramService.getMediaInsights(post.id, account.accessToken, post.media_type);
        return { ...post, ...insights };
      } catch (err) {
        return post;
      }
    }));

    await cache.set(cacheKey, enrichedPosts, 600); // 10 min TTL

    res.status(200).json({ success: true, data: enrichedPosts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Instagram posts', message: error.message });
  }
};

// Fetch Insights for a specific Post (requested)
const getPostInsights = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const account = await InstagramAccount.findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const insights = await instagramService.getMediaInsights(mediaId, account.accessToken);

    res.status(200).json({
      success: true,
      data: insights
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch post insights',
      message: error.message
    });
  }
};

module.exports = {
  initiateAuth,
  handleOAuthCallback,
  getAccountDetails,
  disconnectAccount,
  getStats,
  getPosts,
  getPostInsights
};
