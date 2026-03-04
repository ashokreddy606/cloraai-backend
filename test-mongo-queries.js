const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
    try {
        await prisma.$connect();
        const now = new Date();

        console.log("Testing user.updateMany...");
        await prisma.user.updateMany({
            where: {
                plan: 'PRO',
                subscriptionStatus: { in: ['ACTIVE', 'CANCELLED'] },
                planEndDate: { lt: now },
            },
            data: {
                plan: 'FREE',
                subscriptionStatus: 'EXPIRED',
                activeRazorpaySubscriptionId: null,
            },
        });
        console.log("user.updateMany success!");

        console.log("Testing scheduledPost.updateMany...");
        const orphanThreshold = new Date(Date.now() - 15 * 60 * 1000);
        await prisma.scheduledPost.updateMany({
            where: {
                status: 'publishing',
                updatedAt: { lt: orphanThreshold }
            },
            data: {
                status: 'scheduled',
                errorMessage: 'Auto-recovered: was stuck in publishing state after server restart.'
            }
        });
        console.log("scheduledPost.updateMany success!");

    } catch (e) {
        console.error("ERROR:", e);
    } finally {
        await prisma.$disconnect();
    }
}

test();
