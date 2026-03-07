const axios = require('axios');
const { encryptToken, decryptToken } = require('../utils/cryptoUtils');
const prisma = require('../lib/prisma');
const { createBreaker } = require('../utils/circuitBreaker');

const instagramBreaker = createBreaker(async (url) => {
  return await axios.get(url);
}, 'Instagram');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v18.0';
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;

// Generate Instagram OAuth URL
const getOAuthUrl = (req, res) => {
  try {
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
    const scope = 'instagram_basic,instagram_manage_insights,instagram_manage_messages,instagram_content_publish,pages_show_list,pages_read_engagement';

    // Create state variable combining explicit identity and timestamp to protect against CSRF
    const stateStr = JSON.stringify({ userId: req.userId, ts: Date.now() });
    const stateEncoded = Buffer.from(stateStr).toString('base64');

    const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code&state=${stateEncoded}`;

    res.status(200).json({
      success: true,
      data: {
        authUrl
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate OAuth URL',
      message: error.message
    });
  }
};

// Handle Instagram OAuth Callback
const handleOAuthCallback = async (req, res) => {
  try {
    const { code, state } = req.body;
    const userId = req.userId; // Take identity from JWT middleware (secure)

    if (!code) {
      return res.status(400).json({
        error: 'Missing parameters',
        message: 'code is required'
      });
    }

    // Optional state validation
    if (state) {
      try {
        const decodedStateStr = Buffer.from(state, 'base64').toString('utf8');
        const stateObj = JSON.parse(decodedStateStr);
        if (stateObj.userId !== userId) {
          return res.status(403).json({ error: 'OAuth state mismatch. Security violation.' });
        }
      } catch (e) {
        console.warn('Invalid state parameter provided');
      }
    }

    // Exchange code for short-lived access token
    const tokenResponse = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      {
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: process.env.INSTAGRAM_REDIRECT_URI,
        code
      }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token: shortLivedToken, user_id } = tokenResponse.data;

    // Immediately exchange for long-lived token (60-day expiry)
    const longLivedResponse = await axios.get(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${INSTAGRAM_APP_SECRET}&access_token=${shortLivedToken}`
    );

    const longLivedToken = longLivedResponse.data.access_token;
    const expiresInSeconds = longLivedResponse.data.expires_in || 5184000;

    // Encrypt token for security
    const secureToken = encryptToken(longLivedToken);

    const expiryDate = new Date();
    expiryDate.setSeconds(expiryDate.getSeconds() + expiresInSeconds);

    // Get user info
    const userResponse = await axios.get(
      `https://graph.instagram.com/me?fields=id,username,name,profile_picture_url&access_token=${longLivedToken}`
    );

    const { username, profile_picture_url } = userResponse.data;

    // Save or update Instagram account
    const instagramAccount = await prisma.instagramAccount.upsert({
      where: { userId },
      update: {
        accessToken: secureToken,
        accessTokenExpiry: expiryDate,
        connectedAt: new Date(),
        isConnected: true
      },
      create: {
        userId,
        instagramUserId: user_id.toString(),
        username,
        profileImage: profile_picture_url,
        accessToken: secureToken,
        accessTokenExpiry: expiryDate
      }
    });

    res.status(200).json({
      success: true,
      data: {
        message: 'Instagram account securely connected!',
        instagramAccount: {
          instagramUserId: instagramAccount.instagramUserId,
          username: instagramAccount.username
        }
      }
    });
  } catch (error) {
    console.error('OAuth callback error:', error?.response?.data || error.message);
    res.status(500).json({
      error: 'OAuth connection failed',
      message: error?.response?.data?.error?.message || error.message
    });
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

module.exports = {
  getOAuthUrl,
  handleOAuthCallback,
  getAccountDetails,
  disconnectAccount
};
