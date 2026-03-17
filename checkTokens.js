const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTokens() {
  const users = await prisma.user.findMany({
    where: { pushToken: { not: null } },
    select: { id: true, email: true, pushToken: true }
  });
  console.log(JSON.stringify(users, null, 2));
  await prisma.$disconnect();
}

checkTokens();
