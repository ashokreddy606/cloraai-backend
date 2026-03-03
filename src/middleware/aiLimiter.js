/**
 * aiLimiter.js
 * AI cost protection middleware for CloraAI.
 *
 * Enforces two layers of protection:
 *   1. Per-user daily cap   — varies by plan and feature
 *   2. Global monthly cap   — circuit breaker across all users
 *
 * Designed for 50,000+ users. Uses pre-indexed DB queries only.
 * Token writing happens AFTER successful OpenAI response (in controllers).
 *
 * Usage in routes:
 *   const { aiLimiter } = require('../middleware/aiLimiter');
 *   router.post('/generate', authenticate, aiLimiter('caption'), captionController.generateCaption);
 */

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

const { appConfig } = require('../config');

// ─── Per-Feature Daily Caps (Dynamic from Config) ────────────────────────
const getDailyCap = (feature, plan) => {
    if (feature === 'caption') {
        const freeCap = appConfig.aiLimits?.freeDailyCaptions ?? 5;
        const proCap = appConfig.aiLimits?.proDailyCaptions ?? 100;
        return (plan === 'FREE') ? freeCap : proCap;
    }
    if (feature === 'brand_deal') {
        return 50; // Brand deals are fixed at 50/day to prevent abuse
    }
    return 10;
};

// ─── Global Monthly Token Budget ─────────────────────────────────────────────
// Default: 5,000,000 tokens ≈ $10 / month for gpt-3.5-turbo
// Override via AI_MONTHLY_TOKEN_BUDGET env var
const GLOBAL_MONTHLY_BUDGET = parseInt(process.env.AI_MONTHLY_TOKEN_BUDGET || '5000000', 10);

// ─── Concurrent AI Call Semaphore ────────────────────────────────────────────
// Hard cap on simultaneous in-flight OpenAI requests.
// Each held OpenAI call occupies ~20–25MB for 1.5–10 seconds.
// Without this cap: 80+ simultaneous calls = OOM crash.
// With this cap: excess requests get a clean 503, server stays alive.
//
// Formula: 4GB VPS safe zone = ~25 concurrent AI calls
// Override via AI_MAX_CONCURRENT env var for larger servers.
const AI_MAX_CONCURRENT = parseInt(process.env.AI_MAX_CONCURRENT || '25', 10);
let activeAICalls = 0;

/**
 * Acquire a concurrent AI slot. Returns true if acquired, false if full.
 * Must be paired with releaseAISlot() in a finally block.
 */
const acquireAISlot = () => {
    if (activeAICalls >= AI_MAX_CONCURRENT) return false;
    activeAICalls++;
    return true;
};

/**
 * Release a concurrent AI slot. Always call this after OpenAI call completes.
 */
const releaseAISlot = () => {
    if (activeAICalls > 0) activeAICalls--;
};

/**
 * Get current semaphore status (for /internal/metrics endpoint).
 */
const getAISlotStatus = () => ({ active: activeAICalls, max: AI_MAX_CONCURRENT });

// ─── Helper: current "YYYY-MM" string ────────────────────────────────────────
const currentMonthStr = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ─── Helper: start of today (UTC midnight) ────────────────────────────────────
const startOfTodayUTC = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
};

// ─── Main Middleware Factory ──────────────────────────────────────────────────
/**
 * @param {string} feature - "caption" | "brand_deal"
 * @returns Express middleware
 */
const aiLimiter = (feature) => async (req, res, next) => {
    try {
        const userId = req.userId;

        // ── 0. Concurrent call semaphore check (FIRST — fastest gate) ────────
        // Checked before DB queries to reject overload instantly.
        if (!acquireAISlot()) {
            logger.warn('AI_LIMITER', `Concurrent AI call limit reached (${activeAICalls}/${AI_MAX_CONCURRENT}). Rejecting.`);
            logger.increment('aiConcurrentLimitHit');
            return res.status(503).json({
                error: 'AI service busy',
                message: 'Our AI service is handling too many requests right now. Please try again in a few seconds.',
                code: 'AI_CONCURRENT_LIMIT',
                retryAfterMs: 3000,
            });
        }

        // Attach slot release to response lifecycle so it ALWAYS fires,
        // even if the controller throws or the client disconnects.
        res.on('finish', releaseAISlot);
        res.on('close', releaseAISlot);


        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { plan: true, role: true },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Skip limit check for ADMIN role
        if (user.role === 'ADMIN') {
            req.aiFeature = feature;
            req.aiPlan = user.plan;
            return next();
        }

        const plan = user.plan; // FREE | PRO | LIFETIME

        const dailyLimit = getDailyCap(feature, plan);

        // ── 2. Per-user daily usage count (indexed on userId, feature, createdAt) ──
        const todayStart = startOfTodayUTC();
        const usedToday = await prisma.aIUsage.count({
            where: {
                userId,
                feature,
                createdAt: { gte: todayStart },
            },
        });

        if (usedToday >= dailyLimit) {
            const resetTime = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
            logger.info('AI_LIMITER', `User ${userId} hit daily ${feature} cap (${dailyLimit}).`);
            logger.increment('aiLimitHit');

            return res.status(403).json({
                error: 'Daily AI limit reached',
                message: plan === 'FREE'
                    ? `Free plan allows ${dailyLimit} ${feature === 'caption' ? 'captions' : 'AI scans'} per day. Upgrade to Pro for more.`
                    : `You have reached today's limit of ${dailyLimit} for this feature.`,
                code: 'PLAN_LIMIT',
                feature,
                limit: dailyLimit,
                used: usedToday,
                resetsAt: resetTime.toISOString(),
                currentPlan: plan,
            });
        }

        // ── 3. Global monthly token circuit breaker ─────────────────────────
        const month = currentMonthStr();
        const { _sum } = await prisma.aIUsage.aggregate({
            _sum: { tokens: true },
            where: { month },
        });
        const globalTokensThisMonth = _sum.tokens ?? 0;

        if (globalTokensThisMonth >= GLOBAL_MONTHLY_BUDGET) {
            logger.error(
                'AI_LIMITER',
                `GLOBAL_AI_BUDGET_EXCEEDED: ${globalTokensThisMonth} / ${GLOBAL_MONTHLY_BUDGET} tokens used for ${month}.`
            );
            logger.increment('globalBudgetExceeded');

            return res.status(503).json({
                error: 'AI service temporarily unavailable',
                message: 'Our AI service is temporarily paused due to high demand. Please try again tomorrow.',
                code: 'GLOBAL_BUDGET_EXCEEDED',
            });
        }

        // ── 4. All checks passed — attach metadata for controllers ──────────
        req.aiFeature = feature;
        req.aiPlan = plan;
        req.aiUsedToday = usedToday;
        next();

    } catch (error) {
        logger.error('AI_LIMITER', 'Middleware error', { error: error.message });

        // ── PHASE 2 FIX: FAIL CLOSED ──
        // If DB errors occur, we MUST block AI usage to protect against
        // billing bypass or OOM if users spam requests during a DB hiccup.
        releaseAISlot();

        return res.status(503).json({
            error: 'AI service validation failed',
            message: 'We are experiencing temporary database issues. AI requests are blocked for your protection. Please try again in a few minutes.',
            code: 'AI_VALIDATION_ERROR'
        });
    }
};

// ─── Token Logger: called by controllers AFTER successful OpenAI call ─────────
/**
 * Records token usage atomically after a successful OpenAI response.
 * Sourced from OpenAI metadata — never from client input.
 *
 * @param {string} userId
 * @param {string} feature  - "caption" | "brand_deal"
 * @param {number} tokens   - from response.data.usage.total_tokens
 */
const logAIUsage = async (userId, feature, tokens) => {
    try {
        if (!userId || !tokens || tokens <= 0) return;
        const month = currentMonthStr();
        await prisma.aIUsage.create({
            data: { userId, feature, tokens, month },
        });
        logger.info('AI_USAGE', `Logged ${tokens} tokens for user ${userId} [${feature}] in ${month}`);
    } catch (error) {
        // Never crash the request over a logging failure
        logger.warn('AI_USAGE', `Failed to log usage for user ${userId}: ${error.message}`);
    }
};

module.exports = { aiLimiter, logAIUsage, getAISlotStatus };
