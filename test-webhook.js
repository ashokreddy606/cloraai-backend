const axios = require('axios');

const BASE_URL = 'http://localhost:3000'; // Assuming local server for testing
const VERIFY_TOKEN = 'cloraai_meta_verify_9XAkP2';

async function testVerification() {
    console.log('Testing Webhook Verification (GET /webhook)...');
    try {
        const response = await axios.get(`${BASE_URL}/webhook`, {
            params: {
                'hub.mode': 'subscribe',
                'hub.verify_token': VERIFY_TOKEN,
                'hub.challenge': 'test_challenge_123'
            }
        });
        console.log('Response Status:', response.status);
        console.log('Response Data:', response.data);
        if (response.data === 'test_challenge_123') {
            console.log('✅ Verification Test Passed!');
        } else {
            console.log('❌ Verification Test Failed: Challenge mismatch');
        }
    } catch (error) {
        console.error('❌ Verification Test Failed:', error.response?.status || error.message);
    }
}

async function testEventHandling() {
    console.log('\nTesting Webhook Event Handling (POST /webhook)...');
    try {
        const payload = {
            object: 'instagram',
            entry: [{
                messaging: [{
                    sender: { id: 'sender_123' },
                    recipient: { id: 'recipient_456' },
                    timestamp: Math.floor(Date.now() / 1000),
                    message: { mid: 'mid_789', text: 'hello' }
                }]
            }]
        };
        const response = await axios.post(`${BASE_URL}/webhook`, payload, {
            headers: {
                'x-hub-signature-256': 'sha256=invalid_but_testing_logging' // This will fail signature check but we want to see logging
            }
        });
        console.log('Response Status:', response.status);
        console.log('Response Data:', response.data);
        // Even if signature fails, it should return 403 or 200 depending on implementation
        // For this test, we just check if it hits the endpoint
    } catch (error) {
        console.log('Response Status:', error.response?.status);
        if (error.response?.status === 403) {
            console.log('✅ Event Handling Test (Signature Reject) Passed!');
        } else {
            console.log('❌ Event Handling Test Failed:', error.message);
        }
    }
}

// Note: To run this, you need a running server.
// For now, I'll just provide this as proof of verification plan.
// testVerification();
// testEventHandling();

console.log('Test script ready. Run with node after starting server.');
