const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/cryptoUtils');
const { google } = require('googleapis');
const prisma = require('../lib/prisma');

// Helper to get a new OAuth2Client instance
const getOAuth2Client = () => {
    return new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
        process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/api/youtube/callback`
    );
};

const SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl', // needed for comments.insert
    'https://www.googleapis.com/auth/userinfo.profile'
];

exports.getAuthUrl = async (req, res) => {
    try {
        const userId = req.query.userId || req.userId || (req.user && (req.user.userId || req.user.id));

        if (!userId) {
            return res.status(401).json({ error: 'User ID is required for authentication' });
        }

        const client = getOAuth2Client();
        const url = client.generateAuthUrl({
            access_type: 'offline', // ensures we get a refresh token
            prompt: 'consent',
            scope: SCOPES,
            state: userId // pass user ID so callback knows who it is
        });

        // Return URL to frontend
        res.status(200).json({ url });
    } catch (error) {
        logger.error('YOUTUBE', 'Generate Auth URL failed', error);
        res.status(500).json({ error: 'Failed to generate auth url' });
    }
};

exports.handleCallback = async (req, res) => {
    try {
        const { code, state } = req.query; // state contains userId
        const userId = state;

        if (!code || !userId) {
            return res.status(400).json({ error: 'Invalid callback parameters' });
        }

        const client = getOAuth2Client();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        // Fetch channel details to store channel ID and metrics (Fix #4)
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

        // Save configuration directly to user model (Fix #1 & #4)
        await prisma.user.update({
            where: { id: userId },
            data: {
                youtubeChannelId: channelId,
                youtubeAccessToken: encrypt(tokens.access_token),
                // Only update refresh token if a new one is provided.
                ...(tokens.refresh_token && { youtubeRefreshToken: encrypt(tokens.refresh_token) }),

                // Store metrics (Fix #4)
                youtubeSubscriberCount: parseInt(stats.subscriberCount || 0),
                youtubeViewCount: parseInt(stats.viewCount || 0),
                youtubeVideoCount: parseInt(stats.videoCount || 0),
                youtubeLastSyncedAt: new Date()
            }
        });

        // In a real app, you might want to redirect back to frontend
        // Redirecting to mobile deep link or a web success page
        const frontendUrl = process.env.FRONTEND_APP_SCHEME || 'cloraai://youtube-success';
        res.redirect(frontendUrl);

    } catch (error) {
        logger.error('YOUTUBE', 'Callback handler failed', error);
        res.status(500).json({ error: 'OAuth callback failed' });
    }
};

exports.getStatus = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId }
        });

        if (!user || !user.youtubeChannelId || !user.youtubeAccessToken) {
            return res.json({ connected: false });
        }

        res.json({
            connected: true,
            channelId: user.youtubeChannelId
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
        const rules = await prisma.youtubeAutomationRule.findMany({
            where: { userId: req.userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json(rules);
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
        res.status(500).json({ error: 'Error creating rule' });
    }
};

exports.updateRule = async (req, res) => {
    try {
        const { id } = req.params;
        const { keyword, replyMessage, isActive, replyDelay, limitPerHour } = req.body;

        // Check ownership
        const existing = await prisma.youtubeAutomationRule.findFirst({
            where: { id, userId: req.userId }
        });

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
        await prisma.youtubeAutomationRule.deleteMany({
            where: { id, userId: req.userId }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error deleting rule' });
    }
};

// ── Leads ──────────────────────────────────────────────────────────────────

exports.getLeads = async (req, res) => {
    try {
        const leads = await prisma.youtubeLead.findMany({
            where: { userId: req.userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json(leads);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching leads' });
    }
};

exports.submitLead = async (req, res) => {
    try {
        const { userId, name, email, phone } = req.body; // userId of the creator capturing the lead

        if (!userId || !name || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const lead = await prisma.youtubeLead.create({
            data: {
                userId,
                name,
                email,
                phone,
                source: 'youtube'
            }
        });

        res.status(201).json({ success: true, message: 'Lead captured successfully' });
    } catch (error) {
        logger.error('YOUTUBE', 'submitLead', error);
        res.status(500).json({ error: 'Failed to capture lead' });
    }
};

// ── Analytics ──────────────────────────────────────────────────────────────

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
