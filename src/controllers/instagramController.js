const axios = require('axios');
const InstagramAccount = require('../../models/InstagramAccount');
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://cloraai.com';

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

    // Get userId from authenticated request OR query parameter (for public initiate)
    const userId = req.userId || req.query.userId || req.query.userid || req.query.userID;
    
    // Determine if we should return JSON based on Accept header or request type
    const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    const isMobileApp = acceptsJson || !acceptsHtml; // Mobile apps often send */* or application/json

    if (!userId) {
      logger.error('INSTAGRAM', `Initiate failed: Missing userId. Query received: ${JSON.stringify(req.query)}`);
      if (isMobileApp) {
        return res.status(400).json({ error: 'Missing User ID' });
      }
      return res.redirect(`${FRONTEND_URL}/instagram-error?message=Missing+User+ID`);
    }

    if (!APP_ID || !REDIRECT_URI) {
      logger.error('INSTAGRAM', `Missing Config: APP_ID=${!!APP_ID}, REDIRECT_URI=${!!REDIRECT_URI}`);
      if (isMobileApp) {
        return res.status(500).json({ error: 'Server configuration error' });
      }
      return res.redirect(`${FRONTEND_URL}/instagram-error?message=Server+Configuration+Error`);
    }

    // Use state for CSRF protection and to pass userId back to the callback
    const state = Buffer.from(JSON.stringify({ userId })).toString('base64');

    const authUrl = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code&state=${state}`;

    logger.info('INSTAGRAM', `Initiating OAuth for user ${userId} (Mode: ${isMobileApp ? 'JSON' : 'Redirect'})`);

    if (isMobileApp) {
      return res.status(200).json({ success: true, data: { authUrl } });
    } else {
      return res.redirect(authUrl);
    }
  } catch (error) {
    logger.error('INSTAGRAM', `Failed to initiate OAuth: ${error.message}`);
    
    // Check if we should return JSON error
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (!acceptsHtml || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(500).json({ error: 'Failed to initiate OAuth', message: error.message });
    }
    
    res.redirect(`${FRONTEND_URL}/instagram-error?message=Failed+to+initiate+OAuth`);
  }
};

// 2. Handle OAuth Callback
const handleOAuthCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    logger.error('INSTAGRAM', `OAuth Error: ${error_description || error}`);
    return res.redirect(`${FRONTEND_URL}/instagram-error?message=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/instagram-error?message=No+code+received`);
  }

  try {
    // Decode userId from state
    let userId;
    try {
      if (state) {
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
        userId = decodedState.userId;
      }
    } catch (e) {
      logger.error('INSTAGRAM', `Failed to decode state: ${e.message}`);
    }

    // Final fallback for userId (if session exists)
    if (!userId) userId = req.userId;

    if (!userId) {
      return res.redirect(`${FRONTEND_URL}/instagram-error?message=Missing+User+Context`);
    }

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

    // Redirect to success landing page
    res.redirect(`${FRONTEND_URL}/instagram-success`);
  } catch (error) {
    logger.error('INSTAGRAM', `OAuth callback failed: ${error.message}`);
    res.redirect(`${FRONTEND_URL}/instagram-error?message=Connection+Failed`);
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
