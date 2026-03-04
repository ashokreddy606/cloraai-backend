const Redis = require('ioredis');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

redisClient.on('error', (err) => {
    logger.error('REDIS', 'Redis connection error', { error: err.message });
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
    }
};

module.exports = { redisClient, cache };
