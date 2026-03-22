const { google } = require('googleapis');
const prisma = require('./src/lib/prisma');
const { decrypt } = require('./src/utils/cryptoUtils');
const { getYoutubeOAuth2Client } = require('./src/config/youtube');

async function verifyToken(userId) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.youtubeAccessToken) {
      console.log('No token found');
      return;
    }

    const client = getYoutubeOAuth2Client();
    const credentials = {
        access_token: decrypt(user.youtubeAccessToken)
    };
    if (user.youtubeRefreshToken) {
        credentials.refresh_token = decrypt(user.youtubeRefreshToken);
    }
    client.setCredentials(credentials);

    console.log('--- Testing Token with googleapis ---');
    const youtube = google.youtube({ version: 'v3', auth: client });
    
    // Try to list channels (minimal scope check)
    try {
        const res = await youtube.channels.list({
            part: 'id,snippet',
            mine: true
        });
        console.log('Channels List Success:', res.data.items?.[0]?.snippet?.title);
    } catch (e) {
        console.log('Channels List Failed:', e.message);
        console.log('Error Details:', e.response?.data);
    }

  } catch (err) {
    console.error('Critical Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

// User ID from logs
verifyToken('69b650e5a06072600e3d20fe');
