const prisma = require('./src/lib/prisma');
const { decrypt } = require('./src/utils/cryptoUtils');

async function checkUser(userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user) {
      console.log('User not found');
      return;
    }
    console.log('--- User YouTube Status ---');
    console.log('ID:', user.id);
    console.log('Has Access Token:', !!user.youtubeAccessToken);
    console.log('Has Refresh Token:', !!user.youtubeRefreshToken);
    console.log('YouTube Connected:', user.youtubeConnected);
    console.log('Channel ID:', user.youtubeChannelId);
    
    if (user.youtubeAccessToken) {
        try {
            const token = decrypt(user.youtubeAccessToken);
            console.log('Access Token Length:', token.length);
        } catch (e) {
            console.log('Access Token Decryption Failed');
        }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

checkUser('69b650e5a06072600e3d20fe');
