const request = require('supertest');
const app = require('../server');
const prisma = require('../src/lib/prisma');

describe('YouTube Controller Tests', () => {
    let testUser;

    beforeAll(async () => {
        const email = `yt_${Date.now()}@example.com`;
        testUser = await prisma.user.create({
            data: {
                email,
                password: 'Password123!',
                username: 'ytuser',
                referralCode: `REF_YT_${Date.now()}`
            }
        });
    });

    afterAll(async () => {
        await prisma.user.deleteMany({
            where: { email: { contains: '@example.com' } }
        });
        await prisma.$disconnect();
    });

    describe('YouTube Token Management', () => {
        it('should fail with invalid token', async () => {
            // Mocking auth might be needed if /api/v1/youtube is protected
            // For now, testing basic endpoint behavior
            const res = await request(app)
                .get('/api/v1/youtube/status')
                .set('Authorization', 'Bearer invalid_token');

            expect(res.status).toBe(401);
        });

        // Add more tests for encryption and scheduling if possible without complex mocks
    });
});
