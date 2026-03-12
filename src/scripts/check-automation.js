const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkAutomation() {
    console.log('--- Checking Automation Data ---');
    
    const users = await prisma.user.findMany({
        where: {
            OR: [
                { youtubeChannelId: { not: null } },
                { instagramAccounts: { some: {} } }
            ]
        },
        include: {
            youtubeRules: true,
            dmAutomations: true,
            instagramAccounts: true
        }
    });

    console.log(`Found ${users.length} users with connected accounts.`);

    users.forEach(user => {
        console.log(`\nUser: ${user.email} (ID: ${user.id})`);
        console.log(`- Instagram Connected: ${user.instagramAccounts.length > 0}`);
        if (user.instagramAccounts.length > 0) {
            console.log(`  - IG IDs: ${user.instagramAccounts.map(a => a.instagramId).join(', ')}`);
        }
        console.log(`- Instagram Rules: ${user.dmAutomations.length}`);
        user.dmAutomations.forEach(r => {
            console.log(`  - [${r.isActive ? 'ACTIVE' : 'INACTIVE'}] Keyword: "${r.keyword}", ReelId: ${r.reelId || 'Global'}`);
        });

        console.log(`- YouTube Connected: ${!!user.youtubeChannelId}`);
        if (user.youtubeChannelId) {
            console.log(`  - Channel ID: ${user.youtubeChannelId}`);
        }
        console.log(`- YouTube Rules: ${user.youtubeRules.length}`);
        user.youtubeRules.forEach(r => {
            console.log(`  - [${r.isActive ? 'ACTIVE' : 'INACTIVE'}] Keyword: "${r.keyword}", VideoId: ${r.videoId || 'Global'}`);
        });
    });

    await prisma.$disconnect();
}

checkAutomation().catch(err => {
    console.error(err);
    process.exit(1);
});
