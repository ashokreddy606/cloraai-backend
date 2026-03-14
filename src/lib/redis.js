const Redis = require('ioredis');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL;
let redis;

if (redisUrl && process.env.NODE_ENV !== 'test') {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    }
  });

  redis.on('connect', () => logger.info('REDIS', 'Connected to Redis server'));
  redis.on('error', (err) => logger.error('REDIS', 'Redis connection error:', { error: err.message }));
} else if (process.env.NODE_ENV === 'production') {
  logger.error('REDIS', 'REDIS_URL is missing in production!');
}

module.exports = redis;
