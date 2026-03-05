const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const admins = await prisma.user.findMany({
        where: { role: 'ADMIN' },
        select: { id: true, email: true, username: true }
    });
    console.log('Admins found:', JSON.stringify(admins, null, 2));
    await prisma.$disconnect();
}

main();
