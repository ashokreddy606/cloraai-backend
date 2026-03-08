const Redis = require('ioredis');

// Use a separate connection for locks to avoid blocking on queue processing
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
        // Stop retrying after 3 attempts if we're not in production to avoid hanging dev startup
        if (process.env.NODE_ENV !== 'production' && times > 3) return null;
        return Math.min(times * 50, 2000);
    }
});

redisClient.on('error', (err) => {
    logger.warn('REDIS_LOCK', 'Redis Lock connection error', { error: err.message });
});

/**
 * Acquire a distributed lock.
 * @param {string} lockName - The unique name of the lock.
 * @param {number} ttlSeconds - Time-to-live for the lock in seconds to prevent deadlocks.
 * @returns {Promise<boolean>} - True if acquired, false if already locked elsewhere.
 */
const acquireLock = async (lockName, ttlSeconds = 60) => {
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
    await redisClient.del(`lock:${lockName}`);
};

module.exports = {
    acquireLock,
    releaseLock
};
