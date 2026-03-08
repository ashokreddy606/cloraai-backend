const Redis = require('ioredis');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        if (times % 10 === 0) {
            logger.warn('REDIS', `Redis connection retry #${times} in ${delay}ms`);
        }
        return delay;
    },
    reconnectOnError(err) {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    }
});

redisClient.on('error', (err) => {
    if (err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED') {
        logger.warn('REDIS', 'Redis connection failed. Features like caching and dashboard metrics will be restricted.', { error: err.message });
    } else {
        logger.error('REDIS', 'Redis unexpected error', { error: err.message, code: err.code });
    }
});

redisClient.on('connect', () => {
    logger.info('REDIS', 'Connected to Redis server');
});

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
            const patterns = [`*:${userId}:*`, `*${userId}*`];
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

        try {
            const cachedData = await cache.get(key);
            if (cachedData) {
                return res.json(cachedData);
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
