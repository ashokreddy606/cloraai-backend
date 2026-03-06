const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { google } = require('googleapis');
const logger = require('../utils/logger');

// Retrieve credentials from .env
const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5000/api/youtube/callback'
);

const SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl', // needed for comments.insert
    'https://www.googleapis.com/auth/userinfo.profile'
];

exports.getAuthUrl = async (req, res) => {
    try {
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline', // ensures we get a refresh token
            prompt: 'consent',
            scope: SCOPES,
            state: req.user.id // pass user ID so callback knows who it is
        });
        res.json({ url });
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

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Fetch channel details to store channel ID
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelRes = await youtube.channels.list({
            part: 'id,snippet',
            mine: true
        });

        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return res.status(404).json({ error: 'No YouTube channel found for this account' });
        }

        const channelId = channelRes.data.items[0].id;

        // Save configuration directly to user model
        await prisma.user.update({
            where: { id: userId },
            data: {
                youtubeChannelId: channelId,
                youtubeAccessToken: tokens.access_token,
                // Only update refresh token if a new one is provided.
                // Google might not send a refresh token on subsequent logins unless prompt=consent is used.
                ...(tokens.refresh_token && { youtubeRefreshToken: tokens.refresh_token })
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
            where: { id: req.user.id }
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
            where: { id: req.user.id },
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
            where: { userId: req.user.id },
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
                userId: req.user.id,
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
            where: { id, userId: req.user.id }
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
            where: { id, userId: req.user.id }
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
            where: { userId: req.user.id },
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
        const userId = req.user.id;

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
