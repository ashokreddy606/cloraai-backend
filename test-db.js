const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '../.env' });

async function testConnection() {
    console.log('Testing Prisma connection...');
    console.log('DATABASE_URL starts with:', process.env.DATABASE_URL?.substring(0, 20));

    const prisma = new PrismaClient({
        datasources: {
            db: { url: process.env.DATABASE_URL }
        }
    });

    try {
        await prisma.$connect();
        console.log('✅ Connected to database successfully.');
        const userCount = await prisma.user.count();
        console.log(`✅ User count: ${userCount}`);

        // Check if there are any users with the email the user is trying to register
        const testUser = await prisma.user.findUnique({
            where: { email: 'ashokreddy.kothapalli7072@gmail.com' }
        });
        console.log('Test user find result:', testUser ? 'Found' : 'Not found');

    } catch (err) {
        console.error('❌ Connection failed:');
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

testConnection();
