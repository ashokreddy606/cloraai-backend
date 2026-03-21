const axios = require('axios');
const InstagramAccount = require('../../models/InstagramAccount');
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');
const { s3Client, awsConfig } = require('../config/aws');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { decryptToken } = require('../utils/cryptoUtils');
const prisma = require('../lib/prisma');
const { notifyPostSuccess } = require('../services/pushNotificationService');

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

    // Use state to pass userId back to the callback
    const state = String(userId);
    const authUrl = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code&state=${state}`;

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
    // Extract userId from state as per requirement
    const stateValue = req.query.state;
    const connectionUserId = stateValue || req.userId;

    logger.info('INSTAGRAM', `Processing callback. State: "${stateValue}" (Type: ${typeof stateValue}), Fallback ID: ${req.userId}, Final ID: ${connectionUserId}`);

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
      pageAccessToken: pageAccessToken,
      instagramAccessToken: accessToken,
      tokenExpiresAt: expiresAt,
      connectedAt: new Date(),
      mediaCount: profileData.media_count || 0
    };

    await InstagramAccount.findOneAndUpdate(
      { userId: connectionUserId },
      accountData,
      { upsert: true, returnDocument: 'after' }
    );

    // 5. Automated Webhook Subscription (Critical for Auto-DM)
    if (facebookPageId && pageAccessToken) {
        logger.info('INSTAGRAM', `Attempting to subscribe page ${facebookPageId} to webhooks...`);
        instagramService.subscribePage(facebookPageId, pageAccessToken).catch(err => {
            logger.error('INSTAGRAM:SUBSCRIBE_SILENT_FAIL', `Silent fail on subscription for page ${facebookPageId}`, { error: err.message });
        });
    }

    logger.info('INSTAGRAM', `Instagram Connected for user ${connectionUserId}`);

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
    
    const enrichedPosts = await Promise.all(posts.slice(0, 50).map(async (post) => {
      try {
        const insights = await instagramService.getMediaInsights(post.id, account.instagramAccessToken, post.media_type);
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

// Synchronous Reel Upload and Post Flow (/api/v1/instagram/upload-reel)
const uploadAndPostReel = async (req, res) => {
  let tempFilePath = null;
  try {
    const { caption } = req.body;
    const userId = req.userId;

    if (!req.file) {
      logger.error('REEL_UPLOAD', "No file provided in request");
      return res.status(400).json({ error: 'No video file provided' });
    }
    
    tempFilePath = req.file.path;
    logger.info('REEL_UPLOAD', `Step 1: Received file for user ${userId}`, { 
      originalname: req.file.originalname, 
      size: req.file.size,
      path: tempFilePath 
    });

    // 1. Upload to S3
    const extension = path.extname(req.file.originalname).toLowerCase() || '.mp4';
    const s3Key = `videos/${uuidv4()}${extension}`;
    const fileStream = fs.createReadStream(tempFilePath);

    const uploadParams = {
      Bucket: awsConfig.bucketName,
      Key: s3Key,
      Body: fileStream,
      ContentType: req.file.verifiedMimeType || req.file.mimetype || 'video/mp4'
    };

    logger.info('REEL_UPLOAD', `Step 2: Uploading to S3 bucket ${awsConfig.bucketName}...`);
    await s3Client.send(new PutObjectCommand(uploadParams));
    
    const videoUrl = `https://${awsConfig.bucketName}.s3.${awsConfig.region}.amazonaws.com/${s3Key}`;
    logger.info('REEL_UPLOAD', `Step 2: S3 upload success`, { videoUrl });

    // 2. Get Instagram Account
    const account = await InstagramAccount.findOne({ userId });
    if (!account) {
        throw new Error('Instagram account not connected. Please connect your account first.');
    }

    const accessToken = decryptToken(account.instagramAccessToken);
    const igUserId = account.instagramId;

    if (!igUserId || !accessToken) {
        throw new Error('Instagram account is missing critical credentials. Please reconnect.');
    }

    // 3. Create Media Container
    logger.info('REEL_UPLOAD', `Step 3: Creating Instagram media container for ${igUserId}...`);
    const containerRes = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${igUserId}/media`,
      null,
      {
        params: {
          media_type: 'REELS',
          video_url: videoUrl,
          caption: caption || '',
          access_token: accessToken
        }
      }
    );

    const creationId = containerRes.data.id;
    if (!creationId) {
      logger.error('REEL_UPLOAD', "Instagram API did not return a creation_id", { response: containerRes.data });
      throw new Error('Failed to create media container on Instagram');
    }

    // 4. Poll for status (Instagram processing can take time)
    logger.info('REEL_UPLOAD', `Step 4: Polling for media status (creationId: ${creationId})...`);
    let status = 'IN_PROGRESS';
    let attempts = 0;
    const maxAttempts = 30; // 30 * 5s = 150s (2.5 minutes)
    const delay = 5000;

    while ((status === 'IN_PROGRESS' || status === 'STARTED') && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delay));
      attempts++;

      try {
        const statusRes = await axios.get(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/${creationId}`,
          {
            params: {
              fields: 'status_code',
              access_token: accessToken
            }
          }
        );
        status = statusRes.data.status_code;
        logger.info('REEL_UPLOAD', `Polling attempt ${attempts}: ${status}`);
      } catch (pollError) {
        logger.warn('REEL_UPLOAD', `Polling error on attempt ${attempts}`, { error: pollError.message });
        // Continue polling if it's a transient network error
      }
    }

    if (status !== 'FINISHED') {
      logger.error('REEL_UPLOAD', `Media processing failed or timed out`, { status, attempts });
      throw new Error(`Instagram media processing failed or timed out (Status: ${status}). Please try again later.`);
    }

    // 5. Final Publish
    logger.info('REEL_UPLOAD', `Step 5: Publishing Reel...`);
    const publishRes = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: accessToken
        }
      }
    );

    const instagramMediaId = publishRes.data.id;
    logger.info('REEL_UPLOAD', `Step 6: Success! Reel live`, { instagramMediaId });

    // 7. Record in Database (for history/analytics)
    try {
        let links = [];
        if (req.body.automationLinks) {
            try {
                links = typeof req.body.automationLinks === 'string' 
                    ? JSON.parse(req.body.automationLinks) 
                    : req.body.automationLinks;
            } catch (e) {
                logger.warn('REEL_UPLOAD', "Failed to parse automationLinks", { error: e.message });
            }
        }

        const scheduledPost = await prisma.scheduledPost.create({
            data: {
                userId,
                platform: 'instagram',
                mediaUrl: videoUrl,
                caption: caption || '',
                scheduledAt: new Date(),
                status: 'PUBLISHED',
                publishedAt: new Date(),
                instagramPostId,
                automationKeyword: req.body.automationKeyword || null,
                automationReply: req.body.automationReply || null,
                automationAppendLinks: req.body.automationAppendLinks === 'true' || req.body.automationAppendLinks === true,
                automationLinks: req.body.automationLinks ? (typeof req.body.automationLinks === 'string' ? req.body.automationLinks : JSON.stringify(req.body.automationLinks)) : null,
            }
        });

        // 8. Create DM Automation rule if requested
        if (scheduledPost.automationKeyword && scheduledPost.automationReply) {
            await prisma.dMAutomation.create({
                data: {
                    userId,
                    keyword: scheduledPost.automationKeyword,
                    autoReplyMessage: scheduledPost.automationReply,
                    isActive: true,
                    reelId: instagramPostId,
                    appendLinks: scheduledPost.automationAppendLinks || false,
                    link1: links[0] || null,
                    link2: links[1] || null,
                    link3: links[2] || null,
                    link4: links[3] || null,
                }
            }).catch(err => logger.error('REEL_UPLOAD', "Failed to create DM automation rule", { error: err.message }));
        }

        // 9. Send success push notification
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { pushToken: true } });
        if (user?.pushToken) {
            notifyPostSuccess(user.pushToken, caption?.substring(0, 40) || 'Your Reel').catch(() => {});
        }

    } catch (dbError) {
        logger.error('REEL_UPLOAD', "Failed to record post in database", { error: dbError.message });
        // Don't fail the request since the Reel is already live on Instagram
    }

    res.status(200).json({
      success: true,
      message: 'Reel posted successfully',
      data: {
        instagramMediaId,
        videoUrl
      }
    });

  } catch (error) {
    logger.error('REEL_UPLOAD', 'CRITICAL FAILURE in uploadAndPostReel', { 
      error: error.message, 
      stack: error.stack,
      details: error.response?.data || null 
    });
    
    const errorMessage = error.response?.data?.error?.message || error.message;
    res.status(500).json({ 
      error: 'Failed to post Reel', 
      message: errorMessage 
    });
  } finally {
    // 6. Cleanup temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, (err) => {
        if (err) logger.error('REEL_UPLOAD', 'Failed to cleanup temp file', { path: tempFilePath, error: err.message });
        else logger.debug('REEL_UPLOAD', `Cleaned up temp file: ${tempFilePath}`);
      });
    }
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
  uploadAndPostReel,
  instagramBreaker
};
