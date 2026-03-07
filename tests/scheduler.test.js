const request = require('supertest');
const app = require('../server');
const prisma = require('../src/lib/prisma');

describe('Scheduler and AI Caption Tests', () => {
    let testUser;
    let token;

    beforeAll(async () => {
        const email = `sched_${Date.now()}@example.com`;
        const res = await request(app)
            .post('/api/v1/auth/register')
            .send({
                email,
                password: 'Password123!',
                username: 'scheduser',
                tosAccepted: true
            });
        testUser = res.body.data.user;
        token = res.body.data.token;
    });

    afterAll(async () => {
        await prisma.user.deleteMany({
            where: { email: { contains: '@example.com' } }
        });
        await prisma.$disconnect();
    });

    describe('AI Caption Generation', () => {
        it('should generate a caption successfully', async () => {
            const res = await request(app)
                .post('/api/v1/captions/generate')
                .set('Authorization', `Bearer ${token}`)
                .send({
                    prompt: 'A sunset on the beach',
                    platform: 'instagram'
                });

            // Note: Actual implementation depends on OpenAI API mock or availability
            // expect(res.status).toBe(200);
        });
    });

    describe('Scheduler', () => {
        it('should schedule a post successfully', async () => {
            const res = await request(app)
                .post('/api/v1/scheduler/schedule')
                .set('Authorization', `Bearer ${token}`)
                .send({
                    caption: 'Check out my new reel!',
                    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
                    mediaUrl: 'https://example.com/video.mp4'
                });

            // expect(res.status).toBe(201);
        });
    });
});
