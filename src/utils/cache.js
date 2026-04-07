const redisClient = require('../lib/redis');
const logger = require('./logger');

// Cache wrapper functions
const cache = {
    async get(key) {
        try {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.warn('REDIS', `Cache get error for key: ${key}`, { error: error.message });
            return null;
        }
    },

    async set(key, value, ttlSeconds = 60) {
        try {
            await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        } catch (error) {
            logger.warn('REDIS', `Cache set error for key: ${key}`, { error: error.message });
        }
    },

    async del(key) {
        try {
            await redisClient.del(key);
        } catch (error) {
            logger.warn('REDIS', `Cache del error for key: ${key}`, { error: error.message });
        }
    },

    /**
     * ✅ FIX: Replaced redis.KEYS() with redis.SCAN() iterator.
     * KEYS blocks the entire Redis server in O(N) and is FATAL at 25K users.
     * SCAN is non-blocking, iterates in small batches, safe for production.
     */
    async clearUserCache(userId) {
        try {
            // Clear route-based caches
            const pattern = `route:${userId}:*`;
            await this._scanAndDelete(pattern);
            
            // Clear primary profile cache
            await this.del(`user:profile:${userId}`);
        } catch (error) {
            logger.warn('REDIS', `Cache clear error for user: ${userId}`, { error: error.message });
        }
    },

    async clearPattern(pattern) {
        try {
            await this._scanAndDelete(pattern);
        } catch (error) {
            logger.warn('REDIS', `Cache clear pattern error: ${pattern}`, { error: error.message });
        }
    },

    /**
     * Internal: Non-blocking SCAN iterator to find and delete keys by pattern.
     * Safe for production at any scale.
     */
    async _scanAndDelete(pattern) {
        let cursor = '0';
        let deleted = 0;
        do {
            const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            cursor = nextCursor;
            if (keys.length > 0) {
                await redisClient.del(keys);
                deleted += keys.length;
            }
        } while (cursor !== '0');

        if (deleted > 0) {
            logger.debug('REDIS', `Deleted ${deleted} keys matching pattern: ${pattern}`);
        }
    }
};

const cacheRoute = (ttlSeconds, keyPrefix = 'route') => {
    return async (req, res, next) => {
        if (redisClient.status !== 'ready' && redisClient.status !== 'connect') {
            return next();
        }

        if (req.method !== 'GET') {
            return next();
        }

        const userId = req.userId || 'guest';
        const key = `${keyPrefix}:${userId}:${req.originalUrl || req.url}`;
        const forceRefresh = req.query.forceRefresh === 'true';

        try {
            if (!forceRefresh) {
                const cachedData = await cache.get(key);
                if (cachedData) {
                    return res.json(cachedData);
                }
            }

            const originalJson = res.json.bind(res);
            res.json = (body) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    cache.set(key, body, ttlSeconds);
                }
                originalJson(body);
            };
            next();
        } catch (error) {
            next();
        }
    };
};

module.exports = { redisClient, cache, cacheRoute };
