const { Queue } = require('bullmq');
const Redis = require('ioredis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

async function seedMockRules(count = 100) {
    console.log(`🌱 Seeding ${count} mock user rules into Redis...`);
    for (let i = 1; i <= count; i++) {
        const userId = `65f0a1b2c3d4e5f${i.toString(16).padStart(9, '0')}`;
        const rulesKey = `rules:ig:${userId}`;
        const mockRules = [
            {
                id: `rule_${i}`,
                userId,
                triggerType: 'keyword',
                keyword: 'price',
                replyType: 'dm',
                dmMessage: 'The price is $99. Check it out!',
                isActive: true
            }
        ];
        await redis.set(rulesKey, JSON.stringify({ instagramRules: mockRules }), 'EX', 3600);
    }
    console.log('✅ Seeding complete.');
}

async function injectJobs(count = 5000) {
    console.log(`🚀 Injecting ${count} jobs into instagramAutomationQueue...`);
    const commentQueue = new Queue('instagramAutomationQueue', { connection: redis });
    
    const batchSize = 500;
    for (let i = 0; i < count; i += batchSize) {
        const jobs = [];
        for (let j = 0; j < batchSize && (i + j) < count; j++) {
            const index = i + j;
            const userId = `65f0a1b2c3d4e5f${(index % 100 + 1).toString(16).padStart(9, '0')}`;
            jobs.push({
                name: 'process_comment',
                data: {
                    userId,
                    instagramId: `ig_${index}`,
                    commentId: `comment_${index}`,
                    mediaId: `media_${index}`,
                    text: 'What is the price?',
                    username: `user_${index}`,
                    timestamp: new Date().toISOString()
                }
            });
        }
        await commentQueue.addBulk(jobs);
        console.log(`   Added ${i + jobs.length}/${count} jobs...`);
    }
    
    await commentQueue.close();
    console.log('✅ Injection complete.');
}

async function main() {
    const args = process.argv.slice(2);
    const spikeSize = parseInt(args[0]) || 5000;
    const userCount = parseInt(args[1]) || 100;

    try {
        await seedMockRules(userCount);
        await injectJobs(spikeSize);
        console.log('\n🔥 LOAD TEST READY!');
        console.log('1. Open a new terminal.');
        console.log('2. Run: $env:DRY_RUN="true"; npm start');
        console.log('3. Watch the logs for SCALING:DELAY_APPLIED and WORKER:DRY_RUN.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Load Test Setup Failed:', err);
        process.exit(1);
    }
}

main();
