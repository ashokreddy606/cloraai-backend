const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '../.env' });

async function checkUsers() {
    const prisma = new PrismaClient({
        datasources: {
            db: { url: process.env.DATABASE_URL }
        }
    });

    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { email: true, createdAt: true, username: true }
        });
        console.log('Last 5 users:');
        users.forEach(u => console.log(`- ${u.email} (${u.username}) at ${u.createdAt}`));
    } catch (err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

checkUsers();
