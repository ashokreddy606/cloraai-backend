const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkIGAccounts() {
    const accounts = await prisma.instagramAccount.findMany({
        include: { user: { select: { email: true } } }
    });

    const summary = accounts.map(a => ({
        id: a.id,
        email: a.user.email,
        instagramId: a.instagramId,
        pageId: a.pageId,
        username: a.username,
        isConnected: a.isConnected,
        hasAccessToken: !!a.instagramAccessToken,
        hasPageAccessToken: !!a.pageAccessToken,
        tokenExpiresAt: a.tokenExpiresAt
    }));

    console.log(JSON.stringify(summary, null, 2));
    await prisma.$disconnect();
}

checkIGAccounts().catch(err => {
    console.error(err);
    process.exit(1);
});
