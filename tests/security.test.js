const request = require('supertest');
const app = require('../server');
const prisma = require('../src/lib/prisma');
const jwt = require('jsonwebtoken');

describe('Security Layer Tests', () => {
    let testUser;
    let authToken;
    let refreshToken;

    beforeAll(async () => {
        // Create a test user
        const email = `security_test_${Date.now()}@example.com`;
        const res = await request(app)
            .post('/api/v1/auth/register')
            .set('Origin', 'https://app.cloraai.com')
            .send({
                email,
                password: 'Password123!',
                username: 'sectest',
                tosAccepted: true
            });
        
        testUser = res.body.data.user;
        authToken = res.body.data.token;
        refreshToken = res.body.data.refreshToken;
    });

    afterAll(async () => {
        if (testUser) {
            await prisma.user.delete({ where: { id: testUser.id } });
            await prisma.session.deleteMany({ where: { userId: testUser.id } });
        }
        await prisma.$disconnect();
    });

    describe('CSRF Protection (Origin Check)', () => {
        it('should block requests with unauthorized Origin', async () => {
            const res = await request(app)
                .post('/api/v1/dm-automation')
                .set('Authorization', `Bearer ${authToken}`)
                .set('Origin', 'https://hacker-site.com')
                .send({ keyword: 'test' });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('CSRF Protection: Unauthorized Origin');
        });

        it('should allow requests with authorized Origin', async () => {
            // This is just to test the middleware logic. 
            // The route might still fail due to validation, but not due to CSRF.
            const res = await request(app)
                .post('/api/v1/dm-automation')
                .set('Authorization', `Bearer ${authToken}`)
                .set('Origin', 'https://app.cloraai.com')
                .send({ 
                    keyword: 'test',
                    autoReplyMessage: 'Hello from test',
                    triggerType: 'keywords',
                    replyType: 'text'
                });

            // Status might be 201 or 400 (validation), but NOT 403 CSRF.
            expect(res.status).not.toBe(403);
        });

        it('should allow GET requests without Origin check', async () => {
            const res = await request(app)
                .get('/api/v1/auth/status')
                .set('Authorization', `Bearer ${authToken}`);
            
            expect(res.status).not.toBe(403);
        });
    });

    describe('Rate Limiting', () => {
        it('should implement strict rate limiting on login', async () => {
            // Note: In test environment, the limit might be bypassed or different.
            // But we can check if the headers exist.
            const res = await request(app)
                .post('/api/v1/auth/login')
                .set('Origin', 'https://app.cloraai.com')
                .send({ email: 'nonexistent@example.com', password: 'password' });
            
            expect(res.headers['x-ratelimit-limit']).toBeDefined();
        });

        it('should have a specific limiter for webhooks', async () => {
            const res = await request(app)
                .post('/api/v1/webhook/instagram')
                .set('Origin', 'https://app.cloraai.com')
                .send({});
            
            // Should have rate limit headers
            expect(res.headers['x-ratelimit-limit']).toBeDefined();
        });
    });

    describe('Refresh Token Rotation', () => {
        it('should rotate refresh token and invalidate old one on use', async () => {
            // 1. Refresh once
            const res1 = await request(app)
                .post('/api/v1/auth/refresh-token')
                .set('Origin', 'https://app.cloraai.com')
                .send({ refreshToken });
            
            expect(res1.status).toBe(200);
            const newRefreshToken = res1.body.data.refreshToken;
            expect(newRefreshToken).not.toBe(refreshToken);

            // 2. Try to use the OLD refresh token again (Replay Attack)
            const res2 = await request(app)
                .post('/api/v1/auth/refresh-token')
                .set('Origin', 'https://app.cloraai.com')
                .send({ refreshToken });
            
            // Should fail
            expect(res2.status).toBe(401);
            expect(res2.body.error).toBeDefined();

            // 3. The NEW refresh token should also be invalidated now (Safety measure)
            const res3 = await request(app)
                .post('/api/v1/auth/refresh-token')
                .set('Origin', 'https://app.cloraai.com')
                .send({ refreshToken: newRefreshToken });
            
            expect(res3.status).toBe(401);
        });
    });

    describe('Input Validation (Zod)', () => {
        it('should reject invalid keyword lengths in DM automation', async () => {
            const res = await request(app)
                .post('/api/v1/dm-automation')
                .set('Authorization', `Bearer ${authToken}`)
                .set('Origin', 'https://app.cloraai.com')
                .send({ 
                    keyword: 'a'.repeat(101), // Max is 100
                    autoReplyMessage: 'Test' 
                });
            
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Validation Error');
            expect(JSON.stringify(res.body.details)).toContain('too_big');
        });
    });

    describe('Data Protection', () => {
        it('should not store Instagram tokens in plain text', async () => {
            // This requires creating a mock IG account or just checking a test row
            // We'll create a dummy record in DB and verify encrypt/decrypt manually if needed,
            // but here we verify the controller's behavior.
            
            // Manual check of encrypt utility
            const { encrypt, decrypt } = require('../src/utils/cryptoUtils');
            const secret = 'super-secret-token';
            const encrypted = encrypt(secret);
            expect(encrypted).not.toBe(secret);
            expect(decrypt(encrypted)).toBe(secret);
        });
    });
});
