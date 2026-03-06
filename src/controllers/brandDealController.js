const { PrismaClient } = require('@prisma/client');
const { OpenAIApi, Configuration } = require('openai');
const { logAIUsage } = require('../middleware/aiLimiter');

const prisma = new PrismaClient();

const openai = new OpenAIApi(new Configuration({
    apiKey: process.env.OPENAI_API_KEY
}));

// Fetch stored brand deals for the user, filtering out ones they've already interacted with
const getBrandDeals = async (req, res) => {
    try {
        const userId = req.userId; // Provided by auth middleware

        // Get IDs of deals the user has already interacted with (ignored or replied)
        const ignored = await prisma.brandDealInteraction.findMany({
            where: { userId },
            select: { brandDealId: true }
        });
        const replied = await prisma.brandDealReply.findMany({
            where: { userId },
            select: { brandDealId: true }
        });

        const interactedIds = [...ignored, ...replied].map(i => i.brandDealId);

        const deals = await prisma.brandDeal.findMany({
            where: {
                id: { notIn: interactedIds },
                isBrandDeal: true
            },
            orderBy: { createdAt: 'desc' },
            take: 50 // Limit to recent 50
        });

        res.status(200).json({
            success: true,
            data: {
                deals
            }
        });
    } catch (error) {
        console.error('Failed to fetch brand deals:', error);
        res.status(500).json({
            error: 'Failed to fetch brand deals',
            message: error.message
        });
    }
};

// Helper to analyze and save actual webhook DMs
const analyzeAndSaveBrandDeal = async (message, senderUsername, userId) => {
    try {
        if (!message || !userId) return null;

        // ── Per-user daily brand_deal scan cap (50/day) ──────────────────────
        // Prevents cost explosion from high-volume creators with many DMs.
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const scansToday = await prisma.aIUsage.count({
            where: {
                userId,
                feature: 'brand_deal',
                createdAt: { gte: todayStart },
            },
        });
        if (scansToday >= 50) {
            return null; // Silent skip — do not throw, do not crash webhook
        }

        const prompt = `You are an AI assistant analyzing Instagram Direct Messages for a creator.
    Determine if the following message is a "Brand Deal" or "Sponsorship Pitch" vs just a regular message/spam.
    If it is a brand deal, assign a confidence score between 0.00 and 1.00. Also determine the likely "dealCategory" (e.g. Fashion, Tech, Fitness, Skincare, Food, Unknown).
    
    Message: "${message}"
    
    Respond STRICTLY in valid JSON format containing three keys:
    {
      "isBrandDeal": boolean,
      "confidence": number,
      "dealCategory": string
    }`;

        let analysis;
        let tokensUsed = 0;
        if (process.env.OPENAI_API_KEY === 'dummy') {
            analysis = { isBrandDeal: true, confidence: 0.95, dealCategory: "Fitness & Apparel" };
            tokensUsed = 50; // mock token count
        } else {
            const response = await openai.createChatCompletion({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'You output only valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
            });
            const content = response.data.choices[0].message.content.trim();
            tokensUsed = response.data.usage?.total_tokens || 0;
            analysis = JSON.parse(content);
        }

        if (analysis.isBrandDeal && analysis.confidence > 0.6) {
            const saved = await prisma.brandDeal.create({
                data: {
                    userId: userId, // Add userId context
                    dmContent: message,
                    senderUsername: senderUsername,
                    confidence: analysis.confidence,
                    isBrandDeal: analysis.isBrandDeal,
                    dealCategory: analysis.dealCategory
                }
            });
            // Log token usage AFTER successful OpenAI response (from API metadata, not client)
            await logAIUsage(userId, 'brand_deal', tokensUsed);
            return saved;
        }
        return null;
    } catch (error) {
        console.error('AI Brand deal analysis failed:', error.message);
        return null; // Fail silently to not crash the webhook
    }
};

// Simulate an incoming DM and pass it through the OpenAI Classifier
const simulateIncomingDM = async (req, res) => {
    try {
        const { message, senderUsername = 'test_brand_agency' } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message content is required for simulation.' });
        }

        const dealRecord = await analyzeAndSaveBrandDeal(message, senderUsername, req.userId);

        res.status(200).json({
            success: true,
            data: {
                savedRecord: dealRecord,
                status: dealRecord ? 'FLAGGED_AS_DEAL' : 'IGNORED'
            }
        });

    } catch (error) {
        console.error('Simulate DM error:', error);
        res.status(500).json({
            error: 'Failed to process DM simulation',
            message: error.message
        });
    }
};

const ignoreDeal = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.userId;

        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }

        // Create an interaction record
        await prisma.brandDealInteraction.upsert({
            where: {
                userId_brandDealId_action: {
                    userId,
                    brandDealId: id,
                    action: 'ignored'
                }
            },
            update: {},
            create: {
                userId,
                brandDealId: id,
                action: 'ignored'
            }
        });

        res.status(200).json({ success: true, message: 'Deal ignored successfully' });
    } catch (error) {
        console.error('Ignore deal error:', error);
        res.status(500).json({ error: 'Failed to ignore deal', message: error.message });
    }
};

// Handle user replying to a brand deal with a pitch
const replyToDeal = async (req, res) => {
    try {
        const { id } = req.params;
        const { pitch } = req.body;
        const userId = req.userId;

        if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid brand deal ID' });
        }

        if (!pitch) {
            return res.status(400).json({ error: 'Pitch is required' });
        }

        // Check if already replied
        const existingInfo = await prisma.brandDealReply.findUnique({
            where: {
                userId_brandDealId: {
                    userId,
                    brandDealId: id
                }
            }
        });

        if (existingInfo) {
            return res.status(400).json({ error: 'You have already sent a pitch for this deal.' });
        }

        const reply = await prisma.brandDealReply.create({
            data: {
                userId,
                brandDealId: id,
                pitch
            }
        });

        res.status(201).json({ success: true, data: { reply } });
    } catch (error) {
        console.error('Reply to deal error:', error);
        res.status(500).json({ error: 'Failed to reply to deal', message: error.message });
    }
};

module.exports = {
    getBrandDeals,
    simulateIncomingDM,
    analyzeAndSaveBrandDeal,
    ignoreDeal,
    replyToDeal
};
