const prisma = require('./src/lib/prisma');
const { Queue } = require('bullmq');
const { connection } = require('./src/utils/queue');

async function checkStatus() {
  console.log('--- DB Status ---');
  const latestPosts = await prisma.scheduledPost.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  latestPosts.forEach(p => {
    console.log(`ID: ${p.id} | Status: ${p.status} | Platform: ${p.platform} | Error: ${p.errorMessage}`);
  });

  console.log('\n--- Queue Status ---');
  const igQueue = new Queue('instagram-publish', { connection });
  const ytQueue = new Queue('youtube-publish', { connection });

  const igCount = await igQueue.getJobCounts('waiting', 'active', 'failed', 'completed');
  const ytCount = await ytQueue.getJobCounts('waiting', 'active', 'failed', 'completed');

  console.log('Instagram Publish Queue:', igCount);
  console.log('YouTube Publish Queue:', ytCount);

  process.exit(0);
}

checkStatus().catch(err => {
  console.error(err);
  process.exit(1);
});
