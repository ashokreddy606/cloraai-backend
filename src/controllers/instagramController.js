const axios = require('axios');
const InstagramAccount = require('../../models/InstagramAccount');
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const instagramBreaker = createBreaker(async (url) => {
  const response = await axios.get(url);
  return response;
}, 'Instagram');

// 1. Initiate Instagram OAuth (Redirect to Meta)
const initiateAuth = (req, res) => {
  try {
    const APP_ID = process.env.INSTAGRAM_APP_ID;
    const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;
    const scope = 'instagram_basic,pages_show_list,pages_read_engagement,instagram_manage_insights,instagram_manage_messages,instagram_manage_comments,business_management';

    // Use state for CSRF protection and to pass userId
    const state = Buffer.from(JSON.stringify({ userId: req.userId })).toString('base64');

    const authUrl = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code&state=${state}`;

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
    const { accessToken, expiresIn } = await instagramService.exchangeCodeForToken(code);

    // 2. Discover Instagram Business Account linked to FB Pages
    const { instagramBusinessAccountId, facebookPageId, pageAccessToken } = await instagramService.getBusinessAccount(accessToken);

    // 3. Fetch Instagram Profile Data
    const profileData = await instagramService.getInstagramProfileData(instagramBusinessAccountId, accessToken);

    // 4. Save/Update Mongoose InstagramAccount
    const expiresInSeconds = parseInt(expiresIn) || 5184000; // Default 60 days
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    const accountData = {
      userId,
      instagramId: instagramBusinessAccountId,
      username: profileData.username || 'Instagram User',
      pageId: facebookPageId,
      pageAccessToken: pageAccessToken,
      instagramAccessToken: accessToken,
      tokenExpiresAt: expiresAt,
      connectedAt: new Date(),
      mediaCount: profileData.media_count || 0
    };

    await InstagramAccount.findOneAndUpdate(
      { userId },
      accountData,
      { upsert: true, returnDocument: 'after' }
    );

    logger.info('INSTAGRAM', `Instagram Connected for user ${userId}`);

    res.status(200).json({
      success: true,
      message: 'Instagram account connected successfully!'
    });
  } catch (error) {
    console.error("Instagram API error:", error.response?.data || error.message);
    res.status(500).json({ error: 'OAuth failed', message: error.message });
  }
};

// Fetch Instagram Account Details (/api/v1/instagram/account)
const getAccountDetails = async (req, res) => {
  try {
    const account = await InstagramAccount.findOne({ userId: req.userId });

    if (!account) {
      return res.status(200).json({
        success: true,
        data: {
          account: null,
          isConnected: false
        }
      });
    }

    const accessToken = account.instagramAccessToken;
    const igUserId = account.instagramId;

    const userData = await instagramBreaker.fire(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${igUserId}?fields=id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website&access_token=${accessToken}`
    );

    if (userData.fallback) {
      return res.status(200).json({
        success: true,
        data: {
          account: {
            username: account.username || 'Connected User',
            followersCount: 0,
            isConnected: true
          }
        }
      });
    }

    const d = userData.data;
    res.status(200).json({
      success: true,
      data: {
        account: {
          username: d.username,
          followersCount: d.followers_count,
          followsCount: d.follows_count,
          mediaCount: d.media_count,
          biography: d.biography,
          website: d.website,
          profileImage: d.profile_picture_url,
          isConnected: true
        }
      }
    });
  } catch (error) {
    console.error("Instagram API error:", error.response?.data || error.message);

    // If token is invalid or request is malformed, return as disconnected gracefully
    if (error.response?.status === 400 || error.response?.status === 401) {
      return res.status(200).json({
        success: true,
        data: {
          account: null,
          isConnected: false
        }
      });
    }

    res.status(500).json({
      error: 'Failed to fetch account details',
      message: error.message
    });
  }
};

// Fetch Instagram Analytics Dashboard (/api/v1/instagram/analytics)
const getAnalytics = async (req, res) => {
  try {
    const account = await InstagramAccount.findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const stats = await instagramService.getAccountStats(account.instagramId, account.instagramAccessToken);

    logger.info('INSTAGRAM', `Analytics Pulled for user ${req.userId}`);

    // Optional: you can query your automation logs to see replies sent
    // For now, returning basic mock data + real stats for the dashboard structure specified
    res.status(200).json({
      success: true,
      data: {
        followers: stats.followers_count || 0,
        following: stats.follows_count || 0,
        posts: stats.media_count || 0,
        comments: 0, // Would be fetched from media endpoints or DB
        repliesSent: 0, // Would be fetched from automation DB
        growthLast30Days: 0
      }
    });
  } catch (error) {
    console.error("Instagram API error:", error.response?.data || error.message);
    if (error.response?.status === 400 || error.response?.status === 401) {
      return res.status(200).json({
        success: true,
        data: {
          followers: 0,
          following: 0,
          posts: 0,
          comments: 0,
          repliesSent: 0,
          growthLast30Days: 0
        }
      });
    }
    res.status(500).json({ error: 'Failed to fetch analytics', message: error.message });
  }
};

// Fetch Instagram Recent Posts (/api/v1/instagram/posts)
const getPosts = async (req, res) => {
  const cacheKey = `instagram_media_enriched_${req.userId}`;

  try {
    const cachedData = await cache.get(cacheKey);
    if (cachedData) return res.status(200).json({ success: true, data: cachedData });

    const account = await InstagramAccount.findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const posts = await instagramService.getUserMedia(account.instagramId, account.instagramAccessToken);

    const enrichedPosts = await Promise.all(posts.slice(0, 10).map(async (post) => {
      try {
        const insights = await instagramService.getMediaInsights(post.id, account.instagramAccessToken, post.media_type);
        return { ...post, ...insights };
      } catch (err) {
        return post;
      }
    }));

    await cache.set(cacheKey, enrichedPosts, 600); // 10 min TTL

    res.status(200).json({ success: true, data: enrichedPosts });
  } catch (error) {
    console.error("Instagram API error:", error.response?.data || error.message);
    if (error.response?.status === 400 || error.response?.status === 401) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }
    res.status(500).json({ error: 'Failed to fetch Instagram posts', message: error.message });
  }
};

// Disconnect Instagram Account
const disconnectAccount = async (req, res) => {
  try {
    await InstagramAccount.deleteOne({ userId: req.userId });

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

// Fetch Insights for a specific Post
const getPostInsights = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const account = await InstagramAccount.findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const insights = await instagramService.getMediaInsights(mediaId, account.instagramAccessToken);

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
  getAnalytics,
  getPosts,
  getPostInsights,
  instagramBreaker
};
