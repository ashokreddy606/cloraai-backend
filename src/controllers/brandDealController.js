const { PrismaClient } = require('@prisma/client');
const { OpenAIApi, Configuration } = require('openai');
const { logAIUsage } = require('../middleware/aiLimiter');

const prisma = new PrismaClient();

const openai = new OpenAIApi(new Configuration({
    apiKey: process.env.OPENAI_API_KEY
}));

// Fetch stored brand deals for the user 
const getBrandDeals = async (req, res) => {
    try {
        const deals = await prisma.brandDeal.findMany({
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

module.exports = {
    getBrandDeals,
    simulateIncomingDM,
    analyzeAndSaveBrandDeal
};
