const axios = require('axios');
const InstagramAccount = require('../../models/InstagramAccount');
const { cache } = require('../utils/cache');
const { createBreaker } = require('../utils/circuitBreaker');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');
const { s3Client, awsConfig } = require('../config/aws');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { notifyPostSuccess } = require('../services/pushNotificationService');
const { instagramQueue, enqueueJob } = require('../utils/queue');

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

// Fetch insights for a specific post (/api/v1/instagram/media/:mediaId/insights)
const getPostInsights = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const account = await InstagramAccount.findOne({ userId: req.userId });
    
    if (!account) {
      return res.status(404).json({ error: 'Instagram account not connected' });
    }

    // Usually we'd need to know the media_type (IMAGE vs VIDEO) for correct metrics.
    // If not provided in params, we can fetch basic metadata first or try to infer.
    // getMediaInsights in service handles this if we pass mediaType.
    
    // 1. Fetch media basic info to get media_type
    const accessToken = account.instagramAccessToken;
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

// Asynchronous Reel Upload and Post Flow (/api/v1/instagram/upload-reel)
const uploadAndPostReel = async (req, res) => {
  let tempFilePath = null;
  try {
    const { 
      caption,
      // Advanced Automation
      automationEnabled,
      isAI, triggerType, replyType, productName, productUrl, 
      productDescription, productImage, mustFollow, dmButtonText,
      automationKeyword, automationReply, automationAppendLinks, automationLinks,
      publicReplies,
      customFollowEnabled, customFollowHeader, customFollowSubtext, 
      followButtonText, followedButtonText, dmReplyEnabled
    } = req.body;
    const userId = req.userId;
    const { appConfig } = require('../config');

    if (appConfig.featureFlags.emergencyStopPosts) {
        return res.status(503).json({ 
            error: 'Service Paused', 
            message: 'All uploads are currently stopped by the administrator.' 
        });
    }

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

    // 1. Create PRELIMINARY ScheduledPost record synchronously for limit enforcement
    logger.info('REEL_UPLOAD', `Step 1: Creating preliminary ScheduledPost record for user ${userId}`);
    const scheduledPost = await prisma.scheduledPost.create({
      data: {
        user: { connect: { id: userId } },
        caption: caption || 'Posted via CloraAI ✨',
        mediaUrl: 'pending-s3-upload', // Temporary placeholder
        scheduledAt: new Date(),
        status: 'publishing',
        platform: 'instagram',
        automationKeyword: automationKeyword || null,
        automationReply: automationReply || null,
        automationAppendLinks: automationAppendLinks === 'true' || automationAppendLinks === true,
        automationLinks: automationLinks ? (typeof automationLinks === 'string' ? automationLinks : JSON.stringify(automationLinks)) : null,
        // Advanced Automation Integration
        isAI: isAI === 'true' || isAI === true,
        triggerType: triggerType || null,
        replyType: replyType || null,
        productName: productName || null,
        productUrl: productUrl || null,
        productDescription: productDescription || null,
        productImage: productImage || null,
        mustFollow: mustFollow === 'true' || mustFollow === true,
        dmButtonText: dmButtonText || null,
        publicReplies: publicReplies || null,
        customFollowEnabled: customFollowEnabled === 'true' || customFollowEnabled === true,
        customFollowHeader: customFollowHeader || null,
        customFollowSubtext: customFollowSubtext || null,
        followButtonText: followButtonText || null,
        followedButtonText: followedButtonText || null,
        dmReplyEnabled: dmReplyEnabled === 'true' || dmReplyEnabled === true
      }
    });

    // 2. Upload to S3
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

    // Update record with the final S3 URL
    await prisma.scheduledPost.update({
      where: { id: scheduledPost.id },
      data: { mediaUrl: videoUrl }
    });

    // 3. Discover Instagram Account
    const account = await InstagramAccount.findOne({ userId });
    if (!account) {
        throw new Error('Instagram account not connected.');
    }


    // 4. Enqueue Job
    logger.info('REEL_UPLOAD', `Step 4: Enqueueing publish job for postId ${scheduledPost.id}`);
    await enqueueJob(instagramQueue, 'publish', { postId: scheduledPost.id, userId });

    // 5. Respond immediately
    res.status(202).json({
      success: true,
      message: 'Reel upload successful. It is now being processed and will be published shortly.',
      data: {
        postId: scheduledPost.id,
        status: 'publishing'
      }
    });

    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  } catch (error) {
    logger.error('REEL_UPLOAD_ERROR', "Failed to upload and post reel", { error: error.message });
    
    // Clean up temp file on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
    
    res.status(500).json({ error: 'Failed to upload and post reel', message: error.message });
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
