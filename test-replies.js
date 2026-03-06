const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
    try {
        const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!admin) {
            console.log('No admin found');
            return;
        }
        const token = jwt.sign({ id: admin.id }, process.env.JWT_SECRET || 'fallback', { expiresIn: '1d' });

        const deal = await prisma.brandDeal.findFirst({
            include: { replies: true }
        });

        if (!deal) {
            console.log('No brand deal found');
            return;
        }

        console.log(`Testing replies endpoint for deal ID: ${deal.id}`);

        // Dynamic import for fetch since node-fetch is ESM based in latest versions, 
        // or just use native absolute fetch if Node > 18
        const res = await fetch(`http://localhost:3000/api/admin/brand-deals/${deal.id}/replies`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        const data = await res.json();
        console.dir(data, { depth: null });

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}
main();
