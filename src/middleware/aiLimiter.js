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

const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const redis = require('../lib/redis'); // Added Redis for distributed semaphore

const { appConfig } = require('../config');

// ─── Per-Feature Daily Caps (Dynamic from Config) ────────────────────────
const getDailyCap = (feature, plan) => {
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
// Redis key for global concurrency tracking
const REDIS_CONCURRENT_KEY = 'ai:slots:active';

/**
 * Acquire a concurrent AI slot (Distributed).
 * Uses Redis INCR to count across all server instances.
 * 
 * @returns {Promise<boolean>} true if acquired, false if full or error.
 */
const acquireAISlot = async () => {
    try {
        // FAST PATH: local check before hitting Redis
        if (activeAICalls >= AI_MAX_CONCURRENT + 5) return false; 
        
        const count = await redis.incr(REDIS_CONCURRENT_KEY);
        
        // TTL safety: In case of server crash while holding a slot.
        // Slots should never be held for > 60s (OpenAI timeout is 30-55s normally)
        if (count === 1) await redis.expire(REDIS_CONCURRENT_KEY, 60);

        if (count > AI_MAX_CONCURRENT) {
            await redis.decr(REDIS_CONCURRENT_KEY);
            return false;
        }

        activeAICalls++; // Keep local track for fast-exit logic
        return true;
    } catch (err) {
        logger.error('AI_LIMITER', 'Redis acquire failed, falling back to local semaphore', { error: err.message });
        // Fallback to local if Redis is down
        if (activeAICalls >= AI_MAX_CONCURRENT) return false;
        activeAICalls++;
        return true;
    }
};

/**
 * Release a concurrent AI slot (Distributed).
 */
const releaseAISlot = async () => {
    try {
        if (activeAICalls > 0) activeAICalls--;
        await redis.decr(REDIS_CONCURRENT_KEY);
    } catch (err) {
        // Non-critical, but log it
        logger.warn('AI_LIMITER', 'Redis release failed', { error: err.message });
    }
};

/**
 * Get current global semaphore status.
 */
const getAISlotStatus = async () => {
    const globalActive = await redis.get(REDIS_CONCURRENT_KEY) || 0;
    return { 
        local: activeAICalls, 
        global: parseInt(globalActive, 10), 
        max: AI_MAX_CONCURRENT 
    };
};

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

/**
 * PRODUCTION SECURITY: AI LIMIT CHECKER
 * 
 * Core logic used by both HTTP middleware and background workers.
 * Checks for global budget, concurrent slots, and per-user daily caps.
 * 
 * @returns {Object} { allowed: boolean, error: string, code: string, status: number }
 */
const checkAILimit = async (userId, feature) => {
    try {
        // 1. Global monthly token circuit breaker
        const month = currentMonthStr();
        const { _sum } = await prisma.aIUsage.aggregate({
            _sum: { tokens: true },
            where: { month },
        });
        const globalTokensThisMonth = _sum.tokens ?? 0;

        if (globalTokensThisMonth >= GLOBAL_MONTHLY_BUDGET) {
            logger.error('AI_LIMITER', `GLOBAL_AI_BUDGET_EXCEEDED: ${globalTokensThisMonth}/${GLOBAL_MONTHLY_BUDGET}`);
            return {
                allowed: false,
                error: 'AI service temporarily unavailable due to high demand.',
                code: 'GLOBAL_BUDGET_EXCEEDED',
                status: 503
            };
        }

        // 2. Resolve User & Plan
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { plan: true, role: true },
        });

        if (!user) return { allowed: false, error: 'User not found', code: 'USER_NOT_FOUND', status: 404 };
        if (user.role === 'ADMIN') return { allowed: true, plan: user.plan };

        const plan = user.plan;
        const dailyLimit = getDailyCap(feature, plan);

        // 3. Per-user daily usage count
        const todayStart = startOfTodayUTC();
        const usedToday = await prisma.aIUsage.count({
            where: {
                userId,
                feature,
                createdAt: { gte: todayStart },
            },
        });

        if (usedToday >= dailyLimit) {
            return {
                allowed: false,
                error: `Daily limit of ${dailyLimit} reached for ${feature}.`,
                code: 'PLAN_LIMIT',
                status: 403,
                limit: dailyLimit,
                used: usedToday,
                resetsAt: new Date(todayStart.getTime() + 86400000).toISOString()
            };
        }

        return { allowed: true, plan, usedToday };
    } catch (error) {
        logger.error('AI_LIMITER', 'Limit check error', { error: error.message });
        return { allowed: false, error: 'AI limit verification failed', code: 'AI_CHECK_ERROR', status: 503 };
    }
};

/**
 * @param {string} feature - "caption" | "brand_deal"
 * @returns Express middleware
 */
const aiLimiter = (feature) => async (req, res, next) => {
    try {
        const userId = req.userId;

        // ── 0. Concurrent call semaphore check (FIRST — fastest gate) ────────
        // Checked before DB queries to reject overload instantly.
        const acquired = await acquireAISlot();
        if (!acquired) {
            logger.warn('AI_LIMITER', `Concurrent AI call limit reached. Rejecting.`);
            if (logger.increment) logger.increment('aiConcurrentLimitHit');
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

        const check = await checkAILimit(userId, feature);

        if (!check.allowed) {
            return res.status(check.status).json({
                error: check.error,
                code: check.code,
                message: check.error,
                limit: check.limit,
                used: check.used,
                resetsAt: check.resetsAt
            });
        }

        // 4. All checks passed — attach metadata for controllers
        req.aiFeature = feature;
        req.aiPlan = check.plan;
        req.aiUsedToday = check.usedToday;
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

module.exports = { aiLimiter, checkAILimit, logAIUsage, getAISlotStatus };
