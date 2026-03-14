const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/cryptoUtils');
const { google } = require('googleapis');
const prisma = require('../lib/prisma');
const jwt = require('jsonwebtoken');
const dayjs = require('dayjs');
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
    'https://www.googleapis.com/auth/youtube.force-ssl',
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
            logger.info('YOUTUBE', 'Token automatically refreshed and saved', { userId });
        }
    } catch (refreshError) {
        logger.error('YOUTUBE', 'Token refresh failed', { userId, error: refreshError.message });
        if (refreshError.message.includes('invalid_grant')) {
            throw new Error('YouTube session expired. Please reconnect your account in settings.');
        }
        throw new Error('Failed to refresh YouTube session: ' + refreshError.message);
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

        // Migrate legacy rules (null channelId) to the newly connected channel
        await prisma.youtubeAutomationRule.updateMany({
            where: { userId, channelId: null },
            data: { channelId }
        });

        // Migrate legacy comments and leads as well
        await prisma.youtubeComment.updateMany({
            where: { userId, channelId: null },
            data: { channelId }
        });

        await prisma.youtubeLead.updateMany({
            where: { userId, channelId: null },
            data: { channelId }
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

        const user = await prisma.user.findUnique({ where: { id: req.userId } });
        const channelId = user?.youtubeChannelId;

        const [rules, total] = await Promise.all([
            prisma.youtubeAutomationRule.findMany({
                where: { userId: req.userId, channelId },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip
            }),
            prisma.youtubeAutomationRule.count({ where: { userId: req.userId, channelId } })
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
        const { keyword, replyMessage, isActive, replyDelay, limitPerHour, videoId, subscriberOnly, onlySubscribers, appendLinks, link1, link2, link3, link4 } = req.body;
        if (!keyword || !replyMessage) {
            return res.status(400).json({ error: 'Keyword and replyMessage are required' });
        }
        const user = await prisma.user.findUnique({ where: { id: req.userId } });
        const channelId = user?.youtubeChannelId;

        const rule = await prisma.youtubeAutomationRule.create({
            data: {
                userId: req.userId,
                channelId,
                keyword: keyword.toLowerCase(),
                replyMessage,
                isActive: isActive !== undefined ? isActive : true,
                replyDelay: replyDelay || 0,
                limitPerHour: limitPerHour || 20,
                videoId: videoId || null,
                onlySubscribers: onlySubscribers !== undefined ? onlySubscribers : (subscriberOnly || false),
                appendLinks: appendLinks || false,
                link1: link1 || null,
                link2: link2 || null,
                link3: link3 || null,
                link4: link4 || null
            }
        });
        res.status(201).json(rule);
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(400).json({ error: 'Rule with this keyword already exists for this scope' });
        }
        logger.error('YOUTUBE', 'createRule error', error);
        res.status(500).json({ error: 'Error creating rule' });
    }
};

exports.updateRule = async (req, res) => {
    try {
        const { id } = req.params;
        const { keyword, replyMessage, isActive, replyDelay, limitPerHour, videoId, subscriberOnly, onlySubscribers, appendLinks, link1, link2, link3, link4 } = req.body;
        const existing = await prisma.youtubeAutomationRule.findFirst({ where: { id, userId: req.userId } });
        if (!existing) return res.status(404).json({ error: 'Rule not found' });
        const updated = await prisma.youtubeAutomationRule.update({
            where: { id },
            data: {
                keyword: keyword ? keyword.toLowerCase() : existing.keyword,
                replyMessage: replyMessage !== undefined ? replyMessage : existing.replyMessage,
                isActive: isActive !== undefined ? isActive : existing.isActive,
                replyDelay: replyDelay !== undefined ? replyDelay : existing.replyDelay,
                limitPerHour: limitPerHour !== undefined ? limitPerHour : existing.limitPerHour,
                videoId: videoId !== undefined ? (videoId || null) : existing.videoId,
                onlySubscribers: onlySubscribers !== undefined ? onlySubscribers : (subscriberOnly !== undefined ? subscriberOnly : existing.onlySubscribers),
                appendLinks: appendLinks !== undefined ? appendLinks : existing.appendLinks,
                link1: link1 !== undefined ? (link1 || null) : existing.link1,
                link2: link2 !== undefined ? (link2 || null) : existing.link2,
                link3: link3 !== undefined ? (link3 || null) : existing.link3,
                link4: link4 !== undefined ? (link4 || null) : existing.link4
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
        if (!id || id.length !== 24) {
            return res.status(400).json({ error: 'Invalid rule ID format' });
        }
        const result = await prisma.youtubeAutomationRule.deleteMany({
            where: { id, userId: req.userId }
        });
        if (result.count === 0) {
            return res.status(404).json({ error: 'Rule not found or unauthorized' });
        }
        res.json({ success: true });
    } catch (error) {
        logger.error('YOUTUBE', 'deleteRule error', error);
        res.status(500).json({ error: 'Error deleting rule' });
    }
};

// ── Leads ──────────────────────────────────────────────────────────────────

exports.getLeads = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        const user = await prisma.user.findUnique({ where: { id: req.userId } });
        const channelId = user?.youtubeChannelId;

        const [leads, total] = await Promise.all([
            prisma.youtubeLead.findMany({
                where: { userId: req.userId, channelId },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip
            }),
            prisma.youtubeLead.count({ where: { userId: req.userId, channelId } })
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
        const userId = req.userId;
        const { name, email, phone } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Missing required fields: name and email' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        const channelId = user?.youtubeChannelId;

        await prisma.youtubeLead.create({
            data: { userId, channelId, name, email, phone, source: 'youtube' }
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
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const channelId = user?.youtubeChannelId;

        const [totalComments, totalReplies, totalLeads] = await Promise.all([
            prisma.youtubeComment.count({ where: { userId, channelId } }),
            prisma.youtubeComment.count({ where: { userId, channelId, replied: true } }),
            prisma.youtubeLead.count({ where: { userId, channelId } })
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
        const client = youtube.context._options.auth; // The OAuth2Client instance
        const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth: client });

        // Fetch channel metadata and lifetime stats
        console.log('[YOUTUBE DEBUG] Fetching channel info...');
        const channelRes = await youtube.channels.list({
            part: 'snippet,statistics,contentDetails',
            mine: true,
        }).catch(err => {
            console.error('[YOUTUBE DEBUG] channels.list failed:', err.response?.data || err.message);
            throw new Error(`YouTube Data API failed: ${err.message}`);
        });

        const channels = channelRes.data.items || [];
        if (channels.length === 0) {
            console.warn('[YOUTUBE DEBUG] No channels found');
            return res.status(404).json({ error: 'No YouTube channel found' });
        }

        // Auto-select the channel with content if multiple exist
        const channel = channels.find(c => parseInt(c.statistics?.viewCount || '0') > 0) || channels[0];
        const channelId = channel.id;
        const stats = channel.statistics;

        console.log('[YOUTUBE DEBUG] Using channel:', {
            id: channelId,
            title: channel.snippet?.title,
            views: stats.viewCount
        });

        // Set date ranges
        const today = dayjs().format('YYYY-MM-DD');
        const minus28d = dayjs().subtract(28, 'day').format('YYYY-MM-DD');
        const minus90d = dayjs().subtract(90, 'day').format('YYYY-MM-DD');
        const minus30d = dayjs().subtract(30, 'day').format('YYYY-MM-DD');

        // Fetch Analytics with safety wrappers
        const [stats28d, stats90d, topContentRes, dailyViewsRes] = await Promise.all([
            youtubeAnalytics.reports.query({
                ids: `channel==${channelId}`,
                startDate: minus28d,
                endDate: today,
                metrics: 'views',
            }).catch(e => {
                console.error('[YOUTUBE DEBUG] 28d query error:', e.response?.data || e.message);
                return { data: { rows: [[0]] } };
            }),
            youtubeAnalytics.reports.query({
                ids: `channel==${channelId}`,
                startDate: minus90d,
                endDate: today,
                metrics: 'views',
            }).catch(e => {
                console.error('[YOUTUBE DEBUG] 90d query error:', e.response?.data || e.message);
                return { data: { rows: [[0]] } };
            }),
            youtubeAnalytics.reports.query({
                ids: `channel==${channelId}`,
                startDate: minus28d,
                endDate: today,
                metrics: 'views,likes,comments',
                dimensions: 'video',
                maxResults: 5,
                sort: '-views',
            }).catch(e => {
                console.error('[YOUTUBE DEBUG] Top content error:', e.response?.data || e.message);
                return { data: { rows: [] } };
            }),
            youtubeAnalytics.reports.query({
                ids: `channel==${channelId}`,
                startDate: minus30d,
                endDate: today,
                metrics: 'views',
                dimensions: 'day',
                sort: 'day',
            }).catch(e => {
                console.error('[YOUTUBE DEBUG] Daily views error:', e.response?.data || e.message);
                return { data: { rows: [] } };
            })
        ]);


        const dailyViews = (dailyViewsRes.data.rows || []).map(row => ({
            date: row[0],
            views: parseInt(row[1] || 0)
        }));

        // Video meta for top content
        let topVideos = [];
        const topVideoIds = topContentRes.data.rows?.map(row => row[0]) || [];
        if (topVideoIds.length > 0) {
            try {
                const videoMetaRes = await youtube.videos.list({
                    part: 'snippet,statistics',
                    id: topVideoIds.join(','),
                });
                topVideos = (videoMetaRes.data.items || []).map(v => {
                    const row = topContentRes.data.rows.find(r => r[0] === v.id);
                    return {
                        id: v.id,
                        title: v.snippet.title,
                        thumbnail: v.snippet.thumbnails?.medium?.url,
                        viewCount: parseInt(row?.[1] || v.statistics?.viewCount || 0),
                        likeCount: parseInt(row?.[2] || v.statistics?.likeCount || 0),
                        commentCount: parseInt(row?.[3] || v.statistics?.commentCount || 0),
                        publishedAt: v.snippet.publishedAt,
                    };
                }).sort((a, b) => b.viewCount - a.viewCount);
            } catch (e) { console.warn('[YOUTUBE DEBUG] Video meta fetch failed', e.message); }
        }

        // Update user stats in DB for cache
        await prisma.user.update({
            where: { id: req.userId },
            data: {
                youtubeSubscriberCount: parseInt(stats.subscriberCount || 0),
                youtubeViewCount: parseInt(stats.viewCount || 0),
                youtubeVideoCount: parseInt(stats.videoCount || 0),
                youtubeLastSyncedAt: new Date(),
            }
        }).catch(e => console.warn('Prisma update failed', e.message));

        const responsePayload = {
            success: true,
            channel: {
                title: channel.snippet.title,
                thumbnail: channel.snippet.thumbnails?.medium?.url,
                customUrl: channel.snippet.customUrl,
            },
            stats: {
                subscriberCount: parseInt(stats.subscriberCount || 0),
                lifetimeViews: parseInt(stats.viewCount || 0),
                views28d: parseInt(stats28d.data.rows?.[0]?.[0] || 0),
                views90d: parseInt(stats90d.data.rows?.[0]?.[0] || 0),
                videoCount: parseInt(stats.videoCount || 0),
                dailyViews,
            },
            topVideos,
        };

        console.log('[YOUTUBE DEBUG] Final Payload:', {
            views28d: responsePayload.stats.views28d,
            views90d: responsePayload.stats.views90d,
            lifetime: responsePayload.stats.lifetimeViews
        });

        res.json(responsePayload);

    } catch (error) {
        console.error('[YOUTUBE CRITICAL ERROR]', error);
        logger.error('YOUTUBE', 'getChannelAnalytics Full Fail', { error: error.message, stack: error.stack });

        try {
            const user = await prisma.user.findUnique({ where: { id: req.userId } });
            res.json({
                success: true,
                cached: true,
                channel: { title: 'Your Channel (Cache)' },
                stats: {
                    subscriberCount: user?.youtubeSubscriberCount || 0,
                    lifetimeViews: user?.youtubeViewCount || 0,
                    videoCount: user?.youtubeVideoCount || 0,
                },
                topVideos: [],
            });
        } catch {
            res.status(500).json({ error: 'Failed to fetch analytics' });
        }
    }
};

// ── Single Video Analytics ──────────────────────────────────────────────────

exports.getVideoAnalytics = async (req, res) => {
    try {
        const { videoId } = req.params;
        const youtube = await getYoutubeClientForUser(req.userId);
        const auth = youtube.context._options.auth;
        const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth });

        // Basic meta
        const videoRes = await youtube.videos.list({
            part: 'snippet,statistics,contentDetails',
            id: videoId,
        });

        if (!videoRes.data.items || videoRes.data.items.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const video = videoRes.data.items[0];
        const publishedAt = video.snippet.publishedAt;
        const endDate = dayjs().format('YYYY-MM-DD');

        // Daily views for this specific video
        const dailyStats = await youtubeAnalytics.reports.query({
            ids: 'channel==MINE',
            startDate: dayjs().subtract(90, 'day').isBefore(dayjs(publishedAt))
                ? dayjs(publishedAt).format('YYYY-MM-DD')
                : dayjs().subtract(90, 'day').format('YYYY-MM-DD'),
            endDate,
            metrics: 'views,estimatedMinutesWatched,averageViewDuration',
            dimensions: 'day',
            filters: `video==${videoId}`,
            sort: 'day',
        }).catch(e => {
            console.error('[YOUTUBE ANALYTICS] video daily stats failed:', e.response?.data || e.message);
            logger.warn('YOUTUBE', 'Video daily stats error', e.message);
            return { data: { rows: [] } };
        });

        const timeSeries = (dailyStats.data.rows || []).map(row => ({
            date: row[0],
            views: parseInt(row[1] || 0),
            watchTime: parseFloat(row[2] || 0),
            avgDuration: parseInt(row[3] || 0)
        }));

        res.json({
            success: true,
            video: {
                id: video.id,
                title: video.snippet.title,
                thumbnail: video.snippet.thumbnails?.maxres?.url || video.snippet.thumbnails?.medium?.url,
                viewCount: parseInt(video.statistics.viewCount || 0),
                likeCount: parseInt(video.statistics.likeCount || 0),
                commentCount: parseInt(video.statistics.commentCount || 0),
                duration: video.contentDetails.duration,
                publishedAt: video.snippet.publishedAt,
            },
            analytics: {
                timeSeries,
                totalLifetimeViews: parseInt(video.statistics.viewCount || 0),
            }
        });
    } catch (error) {
        logger.error('YOUTUBE', 'getVideoAnalytics', error);
        res.status(500).json({ error: 'Error fetching video analytics' });
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
        tempFilePath = req.file?.path;
        const s3Url = req.body.videoUrl; // In case they send an S3 URL directly

        if (!tempFilePath && !s3Url) {
            return res.status(400).json({ error: 'Video file or videoUrl is required' });
        }

        // If it's an S3 URL, we need to download it first (YouTube API needs a stream/file)
        if (s3Url && !tempFilePath) {
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const axios = require('axios');
            
            const tempDir = path.join(os.tmpdir(), 'cloraai-uploads');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            
            tempFilePath = path.join(tempDir, `yt_upload_${Date.now()}.mp4`);
            
            const response = await axios({
                method: 'get',
                url: s3Url,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        }

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

        if (!videoId) {
            return res.status(400).json({ error: 'Video ID is required' });
        }

        // 1. Verify ownership more robustly
        // Fetch the video and check if it belongs to the authenticated user's channel
        const videoRes = await youtube.videos.list({
            part: 'snippet',
            id: videoId
        });

        if (!videoRes.data.items || videoRes.data.items.length === 0) {
            return res.status(404).json({ error: 'Video not found on YouTube' });
        }

        const videoChannelId = videoRes.data.items[0].snippet.channelId;

        // Fetch user's own channel ID
        const channelRes = await youtube.channels.list({
            part: 'id',
            mine: true
        });

        const myChannelId = channelRes.data.items?.[0]?.id;

        if (!myChannelId || videoChannelId !== myChannelId) {
            logger.warn('YOUTUBE', 'Unauthorized delete attempt', { userId: req.userId, videoId, videoChannelId, myChannelId });
            return res.status(403).json({ error: 'Unauthorized: You do not own this video' });
        }

        // 2. Perform deletion
        await youtube.videos.delete({ id: videoId });

        logger.info('YOUTUBE', 'Video deleted successfully', { userId: req.userId, videoId });
        res.json({ success: true, message: 'Video deleted' });
    } catch (error) {
        logger.error('YOUTUBE', 'deleteVideo error', {
            userId: req.userId,
            videoId: req.params.videoId,
            error: error.message,
            stack: error.stack,
            details: error.response?.data
        });

        const status = error.response?.status || 500;
        const message = error.response?.data?.error?.message || error.message || 'Error deleting video';

        res.status(status).json({
            error: 'Error deleting video',
            message: message
        });
    }
};
