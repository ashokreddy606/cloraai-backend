const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { decryptToken } = require('./src/utils/cryptoUtils');

const prisma = new PrismaClient();

async function run() {
    try {
        const acc = await prisma.instagramAccount.findFirst();
        const token = decryptToken(acc.pageAccessToken);
        const url = `https://graph.facebook.com/v22.0/${acc.pageId}/subscribed_apps`;
        
        console.log(`Subscribing page ${acc.pageId} to app with 'feed', 'messages', 'messaging_postbacks' fields...`);
        
        const res = await axios.post(url, null, {
            params: {
                subscribed_fields: 'messages,messaging_postbacks,feed',
                access_token: token
            }
        });
        
        console.log('Successfully Subscribed Page Webhook:', res.data);
    } catch(err) {
        console.error('Subscription Error:', err.response?.data || err.message);
    }
    process.exit(0);
}

run();
