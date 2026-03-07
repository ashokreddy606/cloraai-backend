const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/cryptoUtils');
const { google } = require('googleapis');
const prisma = require('../lib/prisma');
const jwt = require('jsonwebtoken');
const { createBreaker } = require('../utils/circuitBreaker');

const youtubeBreaker = createBreaker(async (fn) => {
    return await fn();
}, 'YouTube', { timeout: 15000 });

// Helper to get a new OAuth2Client instance
const getOAuth2Client = () => {
    return new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
        process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/api/v1/youtube/callback`
    );
};

// Minimum required scopes for CloraAI YouTube features
// Reduced from broad scopes to principle of least privilege
const SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
];

// Helper: get authenticated YouTube client for the current user
const getYoutubeClientForUser = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.youtubeAccessToken) {
        throw new Error('YouTube not connected for this user');
    }
    const client = getOAuth2Client();

    // Set credentials with both access and refresh tokens
    const credentials = {
        access_token: decrypt(user.youtubeAccessToken)
    };

    if (user.youtubeRefreshToken) {
        credentials.refresh_token = decrypt(user.youtubeRefreshToken);
    }

    client.setCredentials(credentials);

    // FIX: Automatically refresh token if expired
    // getAccessToken() will automatically refresh if a refresh_token is available and the access_token has expired.
    try {
        const { token } = await client.getAccessToken();

        // If token was refreshed, update DB
        if (token && token !== credentials.access_token) {
            await prisma.user.update({
                where: { id: userId },
                data: { youtubeAccessToken: encrypt(token) }
            });
        }
    } catch (refreshError) {
        logger.error('YOUTUBE', 'Token refresh failed', { userId, error: refreshError.message });
        throw new Error('YouTube session expired. Please reconnect your account.');
    }

    return google.youtube({ version: 'v3', auth: client });
};

exports.getAuthUrl = async (req, res) => {
    try {
        const userId = req.query.userId || req.userId || (req.user && (req.user.userId || req.user.id));
        if (!userId) {
            return res.status(401).json({ error: 'User ID is required for authentication' });
        }
        if (!process.env.JWT_SECRET) {
            return res.status(500).json({ error: 'Server configuration error' });
        }
        const client = getOAuth2Client();
        // Sign state with JWT so it can be cryptographically verified in callback
        const signedState = jwt.sign(
            { userId },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );
        const url = client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: SCOPES,
            state: signedState
        });
        res.status(200).json({ url });
    } catch (error) {
        logger.error('YOUTUBE', 'Generate Auth URL failed', error);
        res.status(500).json({ error: 'Failed to generate auth url' });
    }
};

exports.handleCallback = async (req, res) => {
    try {
        const { code, state } = req.query;

        if (!code || !state) {
            return res.status(400).json({ error: 'Invalid callback parameters' });
        }

        // Verify and decode the signed state JWT to extract userId securely
        let userId;
        try {
            const decoded = jwt.verify(state, process.env.JWT_SECRET);
            userId = decoded.userId;
        } catch (stateError) {
            logger.warn('YOUTUBE', 'OAuth state JWT verification failed', { error: stateError.message });
            return res.status(401).json({ error: 'Invalid or expired OAuth state. Please restart the connection flow.' });
        }

        const client = getOAuth2Client();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        const youtube = google.youtube({ version: 'v3', auth: client });
        const channelRes = await youtube.channels.list({
            part: 'id,snippet,statistics',
            mine: true
        });

        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return res.status(404).json({ error: 'No YouTube channel found for this account' });
        }

        const channel = channelRes.data.items[0];
        const channelId = channel.id;
        const stats = channel.statistics;

        await prisma.user.update({
            where: { id: userId },
            data: {
                youtubeChannelId: channelId,
                youtubeAccessToken: encrypt(tokens.access_token),
                ...(tokens.refresh_token && { youtubeRefreshToken: encrypt(tokens.refresh_token) }),
                youtubeSubscriberCount: parseInt(stats.subscriberCount || 0),
                youtubeViewCount: parseInt(stats.viewCount || 0),
                youtubeVideoCount: parseInt(stats.videoCount || 0),
                youtubeLastSyncedAt: new Date()
            }
        });

        const frontendUrl = process.env.FRONTEND_APP_SCHEME || 'cloraai://youtube-success';
        res.redirect(frontendUrl);
    } catch (error) {
        logger.error('YOUTUBE', 'Callback handler failed', error);
        res.status(500).json({ error: 'OAuth callback failed' });
    }
};

exports.getStatus = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.userId } });
        if (!user || !user.youtubeChannelId || !user.youtubeAccessToken) {
            return res.json({ connected: false });
        }
        res.json({
            connected: true,
            channelId: user.youtubeChannelId,
            subscriberCount: user.youtubeSubscriberCount,
            viewCount: user.youtubeViewCount,
            videoCount: user.youtubeVideoCount,
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error retrieving status' });
    }
};

exports.disconnect = async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.userId },
            data: {
                youtubeChannelId: null,
                youtubeAccessToken: null,
                youtubeRefreshToken: null
            }
        });
        res.json({ success: true, message: 'Disconnected from YouTube' });
    } catch (error) {
        res.status(500).json({ error: 'Server error disconnecting' });
    }
};

// ── Automation Rules ───────────────────────────────────────────────────────

exports.getRules = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        const [rules, total] = await Promise.all([
            prisma.youtubeAutomationRule.findMany({
                where: { userId: req.userId },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip
            }),
            prisma.youtubeAutomationRule.count({ where: { userId: req.userId } })
        ]);

        res.json({
            data: rules,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching rules' });
    }
};

exports.createRule = async (req, res) => {
    try {
        const { keyword, replyMessage, isActive, replyDelay, limitPerHour } = req.body;
        if (!keyword || !replyMessage) {
            return res.status(400).json({ error: 'Keyword and replyMessage are required' });
        }
        const rule = await prisma.youtubeAutomationRule.create({
            data: {
                userId: req.userId,
                keyword: keyword.toLowerCase(),
                replyMessage,
                isActive: isActive !== undefined ? isActive : true,
                replyDelay: replyDelay || 0,
                limitPerHour: limitPerHour || 20
            }
        });
        res.status(201).json(rule);
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(400).json({ error: 'Rule with this keyword already exists' });
        }
        logger.error('YOUTUBE', 'createRule error', error);
        res.status(500).json({ error: 'Error creating rule' });
    }
};

exports.updateRule = async (req, res) => {
    try {
        const { id } = req.params;
        const { keyword, replyMessage, isActive, replyDelay, limitPerHour } = req.body;
        const existing = await prisma.youtubeAutomationRule.findFirst({ where: { id, userId: req.userId } });
        if (!existing) return res.status(404).json({ error: 'Rule not found' });
        const updated = await prisma.youtubeAutomationRule.update({
            where: { id },
            data: {
                keyword: keyword ? keyword.toLowerCase() : existing.keyword,
                replyMessage: replyMessage !== undefined ? replyMessage : existing.replyMessage,
                isActive: isActive !== undefined ? isActive : existing.isActive,
                replyDelay: replyDelay !== undefined ? replyDelay : existing.replyDelay,
                limitPerHour: limitPerHour !== undefined ? limitPerHour : existing.limitPerHour
            }
        });
        res.json(updated);
    } catch (error) {
        logger.error('YOUTUBE', 'updateRule', error);
        res.status(500).json({ error: 'Error updating rule' });
    }
};

exports.deleteRule = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.youtubeAutomationRule.deleteMany({ where: { id, userId: req.userId } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error deleting rule' });
    }
};

// ── Leads ──────────────────────────────────────────────────────────────────

exports.getLeads = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        const [leads, total] = await Promise.all([
            prisma.youtubeLead.findMany({
                where: { userId: req.userId },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip
            }),
            prisma.youtubeLead.count({ where: { userId: req.userId } })
        ]);

        res.json({
            data: leads,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching leads' });
    }
};

exports.submitLead = async (req, res) => {
    try {
        // FIX: Always use authenticated userId from token instead of req.body
        const userId = req.userId;
        const { name, email, phone } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Missing required fields: name and email' });
        }
        await prisma.youtubeLead.create({
            data: { userId, name, email, phone, source: 'youtube' }
        });
        res.status(201).json({ success: true, message: 'Lead captured successfully' });
    } catch (error) {
        logger.error('YOUTUBE', 'submitLead', error);
        res.status(500).json({ error: 'Failed to capture lead' });
    }
};

// ── Analytics (automation) ──────────────────────────────────────────────────

exports.getAnalytics = async (req, res) => {
    try {
        const userId = req.userId;
        const [totalComments, totalReplies, totalLeads] = await Promise.all([
            prisma.youtubeComment.count({ where: { userId } }),
            prisma.youtubeComment.count({ where: { userId, replied: true } }),
            prisma.youtubeLead.count({ where: { userId } })
        ]);
        const conversionRate = totalReplies > 0 ? ((totalLeads / totalReplies) * 100).toFixed(2) : 0;
        res.json({
            totalComments,
            totalReplies,
            totalLeads,
            conversionRate: parseFloat(conversionRate)
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching analytics' });
    }
};

// ── Channel Analytics (Real YouTube Data API) ─────────────────────────────

exports.getChannelAnalytics = async (req, res) => {
    try {
        const youtube = await getYoutubeClientForUser(req.userId);

        // Fetch channel stats
        const channelRes = await youtubeBreaker.fire(() => youtube.channels.list({
            part: 'snippet,statistics,contentDetails',
            mine: true,
        }));

        if (channelRes.fallback) throw new Error("YouTube API Circuit Breaker Fallback");

        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return res.status(404).json({ error: 'No YouTube channel found' });
        }

        const channel = channelRes.data.items[0];
        const stats = channel.statistics;

        // Get most viewed videos from the channel's uploads playlist
        const uploadsRes = await youtube.channels.list({
            part: 'contentDetails',
            mine: true,
        });

        let topVideos = [];
        const uploadsPlaylistId = uploadsRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

        if (uploadsPlaylistId) {
            const playlistRes = await youtube.playlistItems.list({
                part: 'snippet,contentDetails',
                playlistId: uploadsPlaylistId,
                maxResults: 10,
            }).catch(() => ({ data: { items: [] } }));

            const videoIds = playlistRes.data.items?.map(i => i.contentDetails.videoId).filter(Boolean) || [];

            if (videoIds.length > 0) {
                const videoStatsRes = await youtube.videos.list({
                    part: 'snippet,statistics',
                    id: videoIds.join(','),
                });
                topVideos = (videoStatsRes.data.items || [])
                    .sort((a, b) => parseInt(b.statistics?.viewCount || 0) - parseInt(a.statistics?.viewCount || 0))
                    .slice(0, 5)
                    .map(v => ({
                        id: v.id,
                        title: v.snippet.title,
                        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
                        viewCount: parseInt(v.statistics?.viewCount || 0),
                        likeCount: parseInt(v.statistics?.likeCount || 0),
                        commentCount: parseInt(v.statistics?.commentCount || 0),
                        publishedAt: v.snippet.publishedAt,
                        privacyStatus: v.snippet.liveBroadcastContent,
                    }));
            }
        }

        // Update cached metrics on user
        await prisma.user.update({
            where: { id: req.userId },
            data: {
                youtubeSubscriberCount: parseInt(stats.subscriberCount || 0),
                youtubeViewCount: parseInt(stats.viewCount || 0),
                youtubeVideoCount: parseInt(stats.videoCount || 0),
                youtubeLastSyncedAt: new Date(),
            }
        });

        res.json({
            success: true,
            channel: {
                title: channel.snippet.title,
                description: channel.snippet.description,
                thumbnail: channel.snippet.thumbnails?.medium?.url,
                customUrl: channel.snippet.customUrl,
                publishedAt: channel.snippet.publishedAt,
            },
            stats: {
                subscriberCount: parseInt(stats.subscriberCount || 0),
                viewCount: parseInt(stats.viewCount || 0),
                videoCount: parseInt(stats.videoCount || 0),
                hiddenSubscriberCount: stats.hiddenSubscriberCount,
            },
            topVideos,
        });
    } catch (error) {
        logger.error('YOUTUBE', 'getChannelAnalytics', error);

        // Fallback to cached data from DB if YouTube API fails
        try {
            const user = await prisma.user.findUnique({ where: { id: req.userId } });
            res.json({
                success: true,
                cached: true,
                channel: { title: 'Your Channel' },
                stats: {
                    subscriberCount: user?.youtubeSubscriberCount || 0,
                    viewCount: user?.youtubeViewCount || 0,
                    videoCount: user?.youtubeVideoCount || 0,
                },
                topVideos: [],
            });
        } catch {
            res.status(500).json({ error: 'Error fetching channel analytics' });
        }
    }
};

// ── Video Management ──────────────────────────────────────────────────────

exports.getUserVideos = async (req, res) => {
    try {
        const youtube = await getYoutubeClientForUser(req.userId);
        const { maxResults = 20 } = req.query;

        // Get uploads playlist
        const channelRes = await youtube.channels.list({
            part: 'contentDetails',
            mine: true,
        });
        const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

        if (!uploadsPlaylistId) {
            return res.json({ success: true, videos: [] });
        }

        const playlistRes = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId: uploadsPlaylistId,
            maxResults: parseInt(maxResults),
        });

        const videoIds = playlistRes.data.items?.map(i => i.contentDetails.videoId).filter(Boolean) || [];

        if (videoIds.length === 0) return res.json({ success: true, videos: [] });

        const videoStatsRes = await youtube.videos.list({
            part: 'snippet,statistics,status',
            id: videoIds.join(','),
        });

        const videos = (videoStatsRes.data.items || []).map(v => ({
            id: v.id,
            title: v.snippet.title,
            description: v.snippet.description,
            tags: v.snippet.tags || [],
            thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
            publishedAt: v.snippet.publishedAt,
            privacyStatus: v.status?.privacyStatus,
            viewCount: parseInt(v.statistics?.viewCount || 0),
            likeCount: parseInt(v.statistics?.likeCount || 0),
            commentCount: parseInt(v.statistics?.commentCount || 0),
        }));

        res.json({ success: true, videos });
    } catch (error) {
        logger.error('YOUTUBE', 'getUserVideos', error);
        res.status(500).json({ error: 'Error fetching videos', message: error.message });
    }
};

exports.uploadVideo = async (req, res) => {
    let tempFilePath = null;
    try {
        const youtube = await getYoutubeClientForUser(req.userId);
        const { title, description, tags, privacyStatus = 'private', publishAt } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'Video file is required' });
        }

        tempFilePath = req.file.path;

        // Parse tags if sent as a JSON string from FormData
        let parsedTags = tags;
        if (typeof tags === 'string') {
            try { parsedTags = JSON.parse(tags); } catch { parsedTags = tags.split(',').map(t => t.trim()).filter(Boolean); }
        }

        const status = { privacyStatus };
        if (privacyStatus === 'private' && publishAt) {
            status.publishAt = new Date(publishAt).toISOString();
        }

        const fs = require('fs');
        const uploadRes = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title,
                    description: description || '',
                    tags: parsedTags || [],
                    categoryId: '22', // People & Blogs default
                },
                status,
            },
            media: {
                body: fs.createReadStream(tempFilePath),
            },
        });

        res.status(201).json({
            success: true,
            video: {
                id: uploadRes.data.id,
                title: uploadRes.data.snippet.title,
                status: uploadRes.data.status.privacyStatus,
                publishAt: uploadRes.data.status.publishAt,
            }
        });
    } catch (error) {
        logger.error('YOUTUBE', 'uploadVideo', error);
        res.status(500).json({ error: 'Error uploading video', message: error.message });
    } finally {
        // Clean up temp file
        if (tempFilePath) {
            const fs = require('fs');
            fs.unlink(tempFilePath, () => { });
        }
    }
};

exports.updateVideo = async (req, res) => {
    try {
        const youtube = await getYoutubeClientForUser(req.userId);
        const { videoId } = req.params;
        const { title, description, tags, privacyStatus } = req.body;

        // Fetch current video first to merge fields
        const currentRes = await youtube.videos.list({
            part: 'snippet,status',
            id: videoId,
        });

        if (!currentRes.data.items || currentRes.data.items.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }
        const current = currentRes.data.items[0];

        const updatedRes = await youtube.videos.update({
            part: 'snippet,status',
            requestBody: {
                id: videoId,
                snippet: {
                    title: title || current.snippet.title,
                    description: description !== undefined ? description : current.snippet.description,
                    tags: tags !== undefined ? tags : current.snippet.tags,
                    categoryId: current.snippet.categoryId,
                },
                status: {
                    privacyStatus: privacyStatus || current.status.privacyStatus,
                },
            },
        });

        res.json({
            success: true,
            video: {
                id: updatedRes.data.id,
                title: updatedRes.data.snippet.title,
                description: updatedRes.data.snippet.description,
                tags: updatedRes.data.snippet.tags,
                privacyStatus: updatedRes.data.status.privacyStatus,
            }
        });
    } catch (error) {
        logger.error('YOUTUBE', 'updateVideo', error);
        res.status(500).json({ error: 'Error updating video', message: error.message });
    }
};

exports.deleteVideo = async (req, res) => {
    try {
        const youtube = await getYoutubeClientForUser(req.userId);
        const { videoId } = req.params;

        // FIX: Verify ownership before deleting
        // We verify ownership by fetching the video from the user's channel uploads playlist
        const channelRes = await youtube.channels.list({
            part: 'contentDetails',
            mine: true,
        });

        const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsPlaylistId) {
            return res.status(403).json({ error: 'Cannot verify video ownership: No uploads playlist found' });
        }

        // Check if the video belongs to this playlist (channel)
        const playlistItemsRes = await youtube.playlistItems.list({
            part: 'id,contentDetails',
            playlistId: uploadsPlaylistId,
            videoId: videoId
        });

        if (!playlistItemsRes.data.items || playlistItemsRes.data.items.length === 0) {
            return res.status(403).json({ error: 'Unauthorized: You do not own this video' });
        }

        await youtube.videos.delete({ id: videoId });
        res.json({ success: true, message: 'Video deleted' });
    } catch (error) {
        logger.error('YOUTUBE', 'deleteVideo', error);
        res.status(500).json({ error: 'Error deleting video', message: error.message });
    }
};
