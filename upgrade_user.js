const { PrismaClient } = require('@prisma/client');

async function upgradeUser() {
    const prisma = new PrismaClient();
    try {
        await prisma.user.updateMany({
            where: { email: 'loadtest_1773401331540@cloraai.com' },
            data: { plan: 'LIFETIME' }
        });
        console.log('User upgraded to LIFETIME PRO');
    } catch (error) {
        console.error('Upgrade failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

upgradeUser();
