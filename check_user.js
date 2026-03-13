const { PrismaClient } = require('@prisma/client');

async function checkUser() {
    const prisma = new PrismaClient();
    try {
        const user = await prisma.user.findFirst({
            where: { email: { contains: 'loadtest_' } }
        });
        console.log('User found:', user);
    } catch (error) {
        console.error('Check failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

checkUser();
