/**
 * Multi-layer Rate Limiter (Redis-based)
 * Enforces per-account, per-endpoint, and global limits to prevent API bans.
 */

const { redisClient } = require('../cache');
const logger = require('../logger');

const LIMITS = {
    INSTAGRAM: {
        dm: { count: 60, window: 3600 },        // ~60 per account per hour
        comment: { count: 120, window: 3600 }   // ~120 per account per hour
    },
    YOUTUBE: {
        comment: { count: 20, window: 3600 }    // ~20 per account per hour
    },
    GLOBAL: {
        rpm: { count: 2000, window: 60 }        // ~2000 global requests per minute
    }
};

/**
 * Checks if an action is allowed based on multi-layer rate limits.
 * @param {string} userId - The unique ID of the user.
 * @param {string} platform - The platform (INSTAGRAM or YOUTUBE).
 * @param {string} actionType - The type of action (dm or comment).
 * @param {number} customLimit - Optional custom limit override for the account.
 * @returns {Promise<{allowed: boolean, retryAfter?: number}>} - Rate limit status.
 */
const checkRateLimit = async (userId, platform, actionType, customLimit = null) => {
    if (!redisClient) return { allowed: true }; // Skip if Redis is missing (local dev)

    try {
        const platformKey = `${platform.toUpperCase()}:${actionType.toLowerCase()}`;
        const defaultLimit = LIMITS[platform.toUpperCase()]?.[actionType.toLowerCase()] || { count: 10, window: 3600 };
        const accountLimit = {
            count: customLimit !== null ? customLimit : defaultLimit.count,
            window: defaultLimit.window
        };
        const globalLimit = LIMITS.GLOBAL.rpm;

        const accountKey = `ratelimit:account:${userId}:${platformKey}`;
        const globalKey = `ratelimit:global:rpm`;

        // MULTI-LEVEL PIPELINE
        const multi = redisClient.multi();
        
        // 1. Account Level Check
        multi.incr(accountKey);
        multi.ttl(accountKey);
        
        // 2. Global Level Check
        multi.incr(globalKey);
        multi.ttl(globalKey);

        const results = await multi.exec();
        
        const accountCount = results[0][1];
        const accountTtl = results[1][1];
        const globalCount = results[2][1];
        const globalTtl = results[3][1];

        // Set expirations if new keys
        if (accountTtl === -1) await redisClient.expire(accountKey, accountLimit.window);
        if (globalTtl === -1) await redisClient.expire(globalKey, globalLimit.window);

        // EVALUATE
        
        // Check Global First
        if (globalCount > globalLimit.count) {
            logger.warn('SCALING:GLOBAL_LIMIT', 'Global rate limit hit!', { globalCount, globalLimit: globalLimit.count });
            return { allowed: false, retryAfter: 10 }; // 10s cooldown for global
        }

        // Check Account
        if (accountCount > accountLimit.count) {
            logger.warn('SCALING:ACCOUNT_LIMIT', `Rate limit hit for ${platformKey} for user ${userId}`, { 
                accountCount, 
                accountLimit: accountLimit.count 
            });
            return { allowed: false, retryAfter: Math.max(0, accountTtl) };
        }

        return { allowed: true };
    } catch (error) {
        logger.error('SCALING:LIMIT_ERROR', 'Failed to check rate limits', { error: error.message });
        return { allowed: true }; // Fail-open: don't block user if Redis logic fails
    }
};

module.exports = { checkRateLimit };
