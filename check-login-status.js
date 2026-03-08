const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '../.env' });

async function checkLoginStatus() {
    const prisma = new PrismaClient({
        datasources: {
            db: { url: process.env.DATABASE_URL }
        }
    });

    try {
        const user = await prisma.user.findUnique({
            where: { email: 'ashokreddy.kothapalli@gmail.com' },
            select: {
                email: true,
                failedLoginAttempts: true,
                lockoutUntil: true,
                updatedAt: true
            }
        });
        console.log('User Login Status:');
        console.log(JSON.stringify(user, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

checkLoginStatus();
