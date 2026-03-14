const promClient = require('prom-client');
const prisma = require('../lib/prisma');
const redisClient = require('../lib/redis');
const { Queue } = require('bullmq');

const scheduledPostQueue = (process.env.NODE_ENV === 'test')
    ? { getWaitingCount: async () => 0, getFailedCount: async () => 0 }
    : new Queue('instagram-publish', { connection: redisClient });

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// AI Latency Histogram
const aiLatencyMicroseconds = new promClient.Histogram({
    name: 'ai_api_latency_seconds',
    help: 'Latency of AI API calls in seconds',
    labelNames: ['provider', 'feature'],
    buckets: [0.5, 1, 2, 5, 10, 20]
});
register.registerMetric(aiLatencyMicroseconds);

// Redis Ping Latency Gauge
const redisLatencyGauge = new promClient.Gauge({
    name: 'redis_latency_seconds',
    help: 'Latency of Redis ping',
});
register.registerMetric(redisLatencyGauge);

// Queue Gauges
const queueWaitingGauge = new promClient.Gauge({
    name: 'queue_backlog_total',
    help: 'Number of waiting jobs in queue',
    labelNames: ['queue_name']
});
register.registerMetric(queueWaitingGauge);

const queueFailedGauge = new promClient.Gauge({
    name: 'worker_failures_total',
    help: 'Number of failed jobs in queue',
    labelNames: ['queue_name']
});
register.registerMetric(queueFailedGauge);

// Function to safely update custom metrics before export
const updateMetrics = async () => {
    // Redis ping
    const startRedis = process.hrtime();
    try {
        await redisClient.ping();
        const diffRedis = process.hrtime(startRedis);
        redisLatencyGauge.set(diffRedis[0] + diffRedis[1] / 1e9);
    } catch (e) {
        redisLatencyGauge.set(-1);
    }

    // Queue backlog and failures
    try {
        const waiting = await scheduledPostQueue.getWaitingCount();
        const failed = await scheduledPostQueue.getFailedCount();
        queueWaitingGauge.set({ queue_name: 'instagram-publish' }, waiting);
        queueFailedGauge.set({ queue_name: 'instagram-publish' }, failed);
    } catch (e) { }
};

module.exports = {
    promClient,
    register,
    aiLatencyMicroseconds,
    updateMetrics
};
