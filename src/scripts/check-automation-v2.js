const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkAutomation() {
    const users = await prisma.user.findMany({
        include: {
            youtubeRules: true,
            dmAutomations: true,
            instagramAccounts: true
        }
    });

    const summary = users.map(user => ({
        email: user.email,
        id: user.id,
        instagram: {
            connected: user.instagramAccounts.length > 0,
            accounts: user.instagramAccounts.map(a => ({
                id: a.instagramId,
                username: a.username,
                isConnected: a.isConnected
            })),
            ruleCount: user.dmAutomations.length,
            activeRules: user.dmAutomations.filter(r => r.isActive).map(r => ({
                keyword: r.keyword,
                reelId: r.reelId
            }))
        },
        youtube: {
            connected: !!user.youtubeChannelId,
            channelId: user.youtubeChannelId,
            ruleCount: user.youtubeRules.length,
            activeRules: user.youtubeRules.filter(r => r.isActive).map(r => ({
                keyword: r.keyword,
                videoId: r.videoId
            }))
        }
    }));

    console.log(JSON.stringify(summary, null, 2));
    await prisma.$disconnect();
}

checkAutomation().catch(err => {
    console.error(err);
    process.exit(1);
});
