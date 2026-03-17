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

    async clearUserCache(userId) {
        try {
            const patterns = [`route:${userId}:*`];
            let allKeys = [];
            for (const p of patterns) {
                const keys = await redisClient.keys(p);
                allKeys = [...allKeys, ...keys];
            }
            if (allKeys.length > 0) {
                await redisClient.del(allKeys);
            }
        } catch (error) {
            logger.warn('REDIS', `Cache clear error for user: ${userId}`, { error: error.message });
        }
    },

    async clearPattern(pattern) {
        try {
            const keys = await redisClient.keys(pattern);
            if (keys.length > 0) {
                await redisClient.del(keys);
            }
        } catch (error) {
            logger.warn('REDIS', `Cache clear pattern error: ${pattern}`, { error: error.message });
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
