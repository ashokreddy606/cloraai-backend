/**
 * scripts/test-push.js
 * Run with: node scripts/test-push.js <userId>
 */
require('dotenv').config();
const { initializeFirebase } = require('../src/lib/firebase');
const notificationService = require('../src/services/notificationService');
const logger = require('../src/utils/logger');

const testPush = async () => {
    const userId = process.argv[2];
    if (!userId) {
        console.error('Usage: node scripts/test-push.js <userId>');
        process.exit(1);
    }

    try {
        console.log(`🚀 Sending test notification to user: ${userId}...`);
        
        // 1. Initialize Firebase (for FCM tokens)
        initializeFirebase();

        // 2. Trigger a sample notification
        // Note: This will enqueue a job in BullMQ (if worker is running)
        // OR we can call processBatchDelivery directly for an instant test.
        
        const prisma = require('../src/lib/prisma');
        const devices = await prisma.deviceToken.findMany({ where: { userId } });
        const tokens = devices.map(d => d.token);

        if (tokens.length === 0) {
            console.warn(`⚠️ No device tokens found for user ${userId}. Make sure the app has registered.`);
            process.exit(0);
        }

        console.log(`📱 Found tokens: ${tokens.join(', ')}`);

        const payload = {
            notification: { title: 'Test Notification 🔔', body: 'This is a test from the CloraAI server.' },
            data: { test: 'true' },
            android: { priority: 'high' },
            apns: { payload: { aps: { alert: { title: 'Test Notification 🔔', body: 'This is a test from the CloraAI server.' } } } }
        };

        const results = await notificationService.processBatchDelivery({
            tokens,
            payload,
            userId
        });

        console.log('✅ Delivery Attempt Complete:');
        console.log(`   Success: ${results.successCount}`);
        console.log(`   Failure: ${results.failureCount}`);

        process.exit(0);
    } catch (err) {
        console.error('❌ Test failed:', err.message);
        process.exit(1);
    }
};

testPush();
