const axios = require("axios");
import { encryptToken, decryptToken } from '../utils/cryptoUtils';
import prisma from '../lib/prisma';
import { exchangeCodeForToken, getBusinessAccount, getAccountStats, getUserMedia, getMediaInsights } from '../services/instagramService';
import { findOneAndUpdate, findOne, deleteOne } from '../../models/InstagramAccount';
import { cache } from '../utils/cache';
import { createBreaker } from '../utils/circuitBreaker';

const instagramBreaker = createBreaker(async (url) => {
  return await get(url);
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
    const { accessToken, expiresIn, instagramUserId } = await exchangeCodeForToken(code);

    // 2. Discover Instagram Business Account linked to FB Pages
    const igBusinessId = await getBusinessAccount(accessToken);

    // 3. Save/Update Mongoose InstagramAccount
    const expiresInSeconds = parseInt(expiresIn) || 5184000; // Default 60 days
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // Fetch basic details to store in Mongoose (for quick access without extra API calls)
    let username = 'Instagram User';
    try {
      const basicData = await get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${igBusinessId}?fields=username&access_token=${accessToken}`);
      username = basicData.data.username;
    } catch (err) {
      console.warn('Could not fetch username during callback:', err.message);
    }

    await findOneAndUpdate(
      { userId },
      {
        instagramUserId: igBusinessId,
        accessToken,
        username, // Store username for fallback
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
    const account = await findOne({ userId: req.userId });

    if (!account) {
      return res.status(200).json({
        success: true,
        data: {
          account: null,
          isConnected: false
        }
      });
    }

    // Use the stored token
    const accessToken = account.accessToken;

    // Fetch latest data from Instagram Business API (Facebooks Graph API for Bus accounts)
    // Business accounts use different endpoint than basic display API
    const igUserId = account.instagramUserId;
    const userData = await instagramBreaker.fire(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${igUserId}?fields=id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website&access_token=${accessToken}`
    );

    if (userData.fallback) {
      // Return cached/stored data if API fails
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

    res.status(200).json({
      success: true,
      data: {
        account: {
          username: userData.data.username,
          followersCount: userData.data.followers_count,
          followsCount: userData.data.follows_count,
          mediaCount: userData.data.media_count,
          biography: userData.data.biography,
          website: userData.data.website,
          profileImage: userData.data.profile_picture_url,
          isConnected: true
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
    await deleteOne({ userId: req.userId });

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

    const account = await findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const stats = await getAccountStats(account.instagramUserId, account.accessToken);

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

    const account = await findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const posts = await getUserMedia(account.instagramUserId, account.accessToken);

    // Enrich top 10 posts with reach/impressions
    const enrichedPosts = await Promise.all(posts.slice(0, 10).map(async (post) => {
      try {
        const insights = await getMediaInsights(post.id, account.accessToken, post.media_type);
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
    const account = await findOne({ userId: req.userId });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const insights = await getMediaInsights(mediaId, account.accessToken);

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

export default {
  initiateAuth,
  handleOAuthCallback,
  getAccountDetails,
  disconnectAccount,
  getStats,
  getPosts,
  getPostInsights
};
