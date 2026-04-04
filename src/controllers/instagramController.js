const axios = require('axios');
// const InstagramAccount = require('../../models/InstagramAccount'); // Deleted in Prisma migration
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/cryptoUtils');
const { s3Client, awsConfig } = require('../config/aws');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { notifyPostSuccess } = require('../services/pushNotificationService');
const { instagramQueue, enqueueJob } = require('../utils/queue');
const jwt = require('jsonwebtoken');

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
    const scope = 'instagram_basic,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging,instagram_manage_insights,instagram_manage_messages,instagram_manage_comments,business_management';

    // SECURITY: Only accept userId from authenticated JWT — never from query params
    const userId = req.userId;
    
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

    // SECURITY: Sign state with JWT to prevent forgery (matches YouTube OAuth pattern)
    const signedState = jwt.sign(
      { userId, type: 'instagram_oauth' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    const authUrl = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code&state=${signedState}`;

    logger.info('INSTAGRAM', `Initiating OAuth for user ${userId}. URL: ${authUrl.replace(APP_ID, 'REDACTED')}`);
    logger.info('INSTAGRAM', `Mode: ${isMobileApp ? 'JSON' : 'Redirect'}`);

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
  logger.info('INSTAGRAM', `Callback reached. Query: ${JSON.stringify(req.query)}`);

  if (error) {
    logger.error('INSTAGRAM', `OAuth Error: ${error_description || error}`);
    return res.redirect(`${FRONTEND_URL}/instagram-error?message=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/instagram-error?message=No+code+received`);
  }

  try {
    // SECURITY: Verify JWT-signed state to prevent account hijacking
    const stateValue = req.query.state;
    let connectionUserId;
    try {
      const decoded = jwt.verify(stateValue, process.env.JWT_SECRET);
      if (decoded.type !== 'instagram_oauth') throw new Error('Invalid state type');
      connectionUserId = decoded.userId;
    } catch (stateErr) {
      logger.warn('INSTAGRAM', `OAuth state JWT verification failed: ${stateErr.message}`);
      return res.redirect(`${FRONTEND_URL}/instagram-error?message=Invalid+or+expired+state`);
    }

    logger.info('INSTAGRAM', `Processing callback. Verified userId: ${connectionUserId}`);

    if (!connectionUserId) {
      logger.error('INSTAGRAM', `Callback failed: Missing User Context. Query keys: ${Object.keys(req.query)}`);
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
      userId: connectionUserId,
      instagramId: instagramBusinessAccountId,
      username: profileData.username || 'Instagram User',
      pageId: facebookPageId,
      pageAccessToken: encrypt(pageAccessToken),
      instagramAccessToken: encrypt(accessToken),
      tokenExpiresAt: expiresAt,
      connectedAt: new Date(),
      mediaCount: profileData.media_count || 0
    };

    await prisma.instagramAccount.upsert({
      where: { userId: connectionUserId },
      create: { 
        userId: connectionUserId,
        instagramId: accountData.instagramId,
        username: accountData.username,
        pageId: accountData.pageId,
        pageAccessToken: accountData.pageAccessToken,
        instagramAccessToken: accountData.instagramAccessToken,
        tokenExpiresAt: accountData.tokenExpiresAt,
        mediaCount: accountData.mediaCount,
        isConnected: true,
        connectedAt: new Date()
      },
      update: {
        instagramId: accountData.instagramId,
        username: accountData.username,
        pageId: accountData.pageId,
        pageAccessToken: accountData.pageAccessToken,
        instagramAccessToken: accountData.instagramAccessToken,
        tokenExpiresAt: accountData.tokenExpiresAt,
        mediaCount: accountData.mediaCount,
        isConnected: true
      }
    });

    // 5. Automated Webhook Subscription (Critical for Auto-DM)
    if (facebookPageId && pageAccessToken) {
        logger.info('INSTAGRAM', `Attempting to subscribe page ${facebookPageId} to webhooks...`);
        instagramService.subscribePage(facebookPageId, pageAccessToken).catch(err => {
            logger.error('INSTAGRAM:SUBSCRIBE_SILENT_FAIL', `Silent fail on subscription for page ${facebookPageId}`, { error: err.message });
        });
    }

    logger.info('INSTAGRAM', `Instagram Connected for user ${connectionUserId}`);

    // ✅ NEW: Notify user of successful connection
    pushNotificationService.notifyLinkSuccess(connectionUserId, 'instagram').catch(() => {});

    // Redirect to success landing page
    res.redirect(`${FRONTEND_URL}/instagram-success`);
  } catch (error) {
    logger.error('CRYPTO', 'Decryption failed: check if TOKEN_ENCRYPTION_SECRET matches the key used during encryption.', { 
        error: error.message,
        secretUsed: process.env.TOKEN_ENCRYPTION_SECRET ? `${process.env.TOKEN_ENCRYPTION_SECRET.substring(0, 3)}***` : 'NONE'
    });
    res.redirect(`${FRONTEND_URL}/instagram-error?message=Connection+Failed`);
  }
};

// Fetch Instagram Account Details (/api/v1/instagram/account)
const getAccountDetails = async (req, res) => {
  try {
    const account = await prisma.instagramAccount.findUnique({ where: { userId: req.userId } });

    if (!account) {
      return res.status(200).json({
        success: true,
        data: {
          account: null,
          isConnected: false
        }
      });
    }

    const accessToken = decrypt(account.instagramAccessToken);
    if (!accessToken) {
      logger.error('INSTAGRAM', 'Decryption failed for access token. Account might need reconnection.');
      return res.status(200).json({ success: true, data: { account: null, isConnected: false } });
    }

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
    logger.error('INSTAGRAM', 'API error in getAccountDetails', { error: error.response?.data?.error?.message || error.message });

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
    const account = await prisma.instagramAccount.findUnique({ where: { userId: req.userId } });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const accessToken = decrypt(account.instagramAccessToken);
    if (!accessToken) return res.status(401).json({ error: 'Invalid access token. Please reconnect Instagram.' });

    const stats = await instagramService.getAccountStats(account.instagramId, accessToken);

    logger.info('INSTAGRAM', `Analytics Pulled for user ${req.userId}`);

    // Calculate Real Analytics
    // 1. Total Replies Sent (from DM Interaction log)
    const repliesSentCount = await prisma.dmInteraction.count({
      where: { userId: req.userId, status: 'sent' }
    });

    // 2. Growth Last 30 Days (Snapshot Comparison)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [latestSnapshot, oldSnapshot] = await Promise.all([
      prisma.analyticsSnapshot.findFirst({
        where: { userId: req.userId },
        orderBy: { snapshotDate: 'desc' }
      }),
      prisma.analyticsSnapshot.findFirst({
        where: { userId: req.userId, snapshotDate: { lte: thirtyDaysAgo } },
        orderBy: { snapshotDate: 'desc' }
      })
    ]);

    let growthValue = 0;
    if (latestSnapshot && oldSnapshot) {
      growthValue = latestSnapshot.followers - oldSnapshot.followers;
    }

    // 3. Comment Aggregation (from Media Service)
    try {
        const accessToken = decrypt(account.instagramAccessToken);
        if (accessToken) {
          const posts = await instagramService.getUserMedia(account.instagramId, accessToken);
          totalComments = posts.reduce((sum, p) => sum + (p.comments_count || 0), 0);
        }
    } catch (e) {
      logger.warn('ANALYTICS:COMMENTS', `Failed to aggregate comments for ${req.userId}`);
    }

    res.status(200).json({
      success: true,
      data: {
        followers: stats.followers_count || 0,
        following: stats.follows_count || 0,
        posts: stats.media_count || 0,
        comments: totalComments,
        repliesSent: repliesSentCount,
        growthLast30Days: growthValue
      }
    });
  } catch (error) {
    logger.error('INSTAGRAM', 'API error in getAnalytics', { error: error.response?.data?.error?.message || error.message });
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

    const account = await prisma.instagramAccount.findUnique({ where: { userId: req.userId } });
    if (!account) return res.status(404).json({ error: 'Instagram account not connected' });

    const accessToken = decrypt(account.instagramAccessToken);
    if (!accessToken) return res.status(401).json({ error: 'Invalid access token. Please reconnect Instagram.' });

    const posts = await instagramService.getUserMedia(account.instagramId, accessToken);
    
    const enrichedPosts = await Promise.all(posts.slice(0, 50).map(async (post) => {
      try {
        const insights = await instagramService.getMediaInsights(post.id, accessToken, post.media_type);
        // Create a display title from caption or metadata
        const displayTitle = post.caption || `Post from ${new Date(post.timestamp).toLocaleDateString()}`;
        return { ...post, ...insights, title: displayTitle };
      } catch (err) {
        return { ...post, title: post.caption || `Post from ${new Date(post.timestamp).toLocaleDateString()}` };
      }
    }));

    await cache.set(cacheKey, enrichedPosts, 600); // 10 min TTL

    res.status(200).json({ success: true, data: enrichedPosts });
  } catch (error) {
    logger.error('INSTAGRAM', 'API error in getPosts', { error: error.response?.data?.error?.message || error.message });
    if (error.response?.status === 400 || error.response?.status === 401) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }
    res.status(500).json({ error: 'Failed to fetch Instagram posts', message: error.message });
  }
};

// Fetch insights for a specific post (/api/v1/instagram/media/:mediaId/insights)
const getPostInsights = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const account = await prisma.instagramAccount.findUnique({ where: { userId: req.userId } });
    
    if (!account) {
      return res.status(404).json({ error: 'Instagram account not connected' });
    }

    // Usually we'd need to know the media_type (IMAGE vs VIDEO) for correct metrics.
    // If not provided in params, we can fetch basic metadata first or try to infer.
    // getMediaInsights in service handles this if we pass mediaType.
    
    // 1. Fetch media basic info to get media_type
    const accessToken = decrypt(account.instagramAccessToken);
    if (!accessToken) return res.status(401).json({ error: 'Invalid access token. Please reconnect Instagram.' });

    const mediaInfoRes = await axios.get(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${mediaId}?fields=media_type&access_token=${accessToken}`
    );
    
    const mediaType = mediaInfoRes.data.media_type;

    // 2. Fetch enriched insights
    const insights = await instagramService.getMediaInsights(mediaId, accessToken, mediaType);
    
    res.status(200).json({
      success: true,
      data: {
        mediaId,
        mediaType,
        insights
      }
    });
  } catch (error) {
    logger.error('INSTAGRAM', `Failed to fetch insights for media ${req.params.mediaId}: ${error.message}`);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch post insights',
      message: error.response?.data?.error?.message || error.message
    });
  }
};

// Disconnect Instagram Account
const disconnectAccount = async (req, res) => {
  try {
    await prisma.instagramAccount.delete({ where: { userId: req.userId } });

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
  initiateAuth,
  handleOAuthCallback,
  getAccountDetails,
  disconnectAccount,
  getAnalytics,
  getPosts,
  getPostInsights,
  instagramBreaker
};
