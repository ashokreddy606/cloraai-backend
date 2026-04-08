const Redis = require('ioredis');
const logger = require('./logger');

const redisUrl = process.env.REDIS_URL;
const isPlaceholder = !redisUrl || redisUrl.startsWith('CHANGE_ME');
let redisClient;

if (redisUrl && !isPlaceholder && process.env.NODE_ENV !== 'test') {
    redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        retryStrategy(times) {
            if (process.env.NODE_ENV !== 'production' && times > 3) return null;
            return Math.min(times * 100, 3000);
        }
    });

    redisClient.on('error', (err) => {
        logger.warn('REDIS_LOCK', 'Redis Lock connection error', { error: err.message });
    });
} else {
    logger.warn('REDIS_LOCK', 'Redis connection missing. Distributed locking disabled (expected in local dev).');
}

/**
 * Acquire a distributed lock.
 * @param {string} lockName - The unique name of the lock.
 * @param {number} ttlSeconds - Time-to-live for the lock in seconds to prevent deadlocks.
 * @returns {Promise<boolean>} - True if acquired, false if already locked elsewhere.
 */
const acquireLock = async (lockName, ttlSeconds = 60) => {
    if (!redisClient) return true; // Bypass in dev if no redis
    // SET NX (Not Exists) EX (Expire in Seconds)
    // Guarantees atomic check-and-set
    const result = await redisClient.set(`lock:${lockName}`, '1', 'NX', 'EX', ttlSeconds);
    return result === 'OK';
};

/**
 * Release a distributed lock.
 * @param {string} lockName - The unique name of the lock.
 */
const releaseLock = async (lockName) => {
    if (!redisClient) return;
    await redisClient.del(`lock:${lockName}`);
};

module.exports = {
    acquireLock,
    releaseLock
};
