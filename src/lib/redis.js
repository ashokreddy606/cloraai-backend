const Redis = require('ioredis');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL;
let redis;

const isPlaceholder = !redisUrl || redisUrl.startsWith('CHANGE_ME');

if (redisUrl && !isPlaceholder && process.env.NODE_ENV !== 'test') {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // Required for BullMQ
    retryStrategy: (times) => Math.min(times * 100, 3000),
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
} else {
  // Use a NO-OP mock client to prevent crashes in dev
  const msg = isPlaceholder ? 'REDIS_URL is a placeholder/missing' : 'REDIS bypassed in tests';
  logger.warn('REDIS', `${msg}. Using mock client (features like Queues/Rate-limiting will be inactive).`);
  
  redis = {
    on: () => { },
    once: () => { },
    get: async () => null,
    set: async () => 'OK',
    del: async () => 0,
    incr: async () => 1,
    decr: async () => 0,
    expire: async () => 1,
    call: async () => null,
    status: 'ready',
    options: {},
    quit: async () => 'OK',
    disconnect: () => { }
  };
}

module.exports = redis;
