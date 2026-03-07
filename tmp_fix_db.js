const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDuplicates() {
    try {
        const users = await prisma.user.findMany({
            where: {
                youtubeChannelId: { not: null }
            },
            select: {
                id: true,
                youtubeChannelId: true
            }
        });

        const counts = {};
        const duplicates = [];

        for (const user of users) {
            if (user.youtubeChannelId) {
                counts[user.youtubeChannelId] = (counts[user.youtubeChannelId] || 0) + 1;
                if (counts[user.youtubeChannelId] > 1) {
                    duplicates.push(user);
                }
            }
        }

        if (duplicates.length > 0) {
            console.log('Found duplicates for youtubeChannelId:');
            console.log(JSON.stringify(duplicates, null, 2));

            // Optionally fix them by setting to null
            for (const dup of duplicates) {
                await prisma.user.update({
                    where: { id: dup.id },
                    data: { youtubeChannelId: null }
                });
                console.log(`Reset youtubeChannelId for user ${dup.id}`);
            }
        } else {
            console.log('No duplicates found.');
        }
    } catch (error) {
        console.error('Error checking duplicates:', error);
    } finally {
        await prisma.$disconnect();
    }
}

checkDuplicates();
