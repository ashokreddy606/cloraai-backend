const request = require('supertest');
const app = require('../server');
const prisma = require('../src/lib/prisma');
const { hashPassword } = require('../src/utils/helpers');

describe('Auth Controller Tests', () => {
    const testUser = {
        email: `test_${Date.now()}@example.com`,
        password: 'Password123!',
        username: 'testuser',
        tosAccepted: true
    };

    beforeAll(async () => {
        // Any setup if needed
    });

    afterAll(async () => {
        // Cleanup test users
        await prisma.user.deleteMany({
            where: { email: { contains: '@example.com' } }
        });
        await prisma.$disconnect();
    });

    describe('POST /api/v1/auth/register', () => {
        it('should register a new user successfully', async () => {
            const res = await request(app)
                .post('/api/v1/auth/register')
                .send(testUser);

            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.user.email).toBe(testUser.email);
            expect(res.body.data.token).toBeDefined();
        });

        it('should fail registration with duplicate email', async () => {
            const res = await request(app)
                .post('/api/v1/auth/register')
                .send(testUser);

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('Email is already registered');
        });

        it('should fail if TOS not accepted', async () => {
            const res = await request(app)
                .post('/api/v1/auth/register')
                .send({ ...testUser, email: 'notos@example.com', tosAccepted: false });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('You must accept the Terms of Service to register');
        });
    });

    describe('POST /api/v1/auth/login', () => {
        it('should login successfully with correct credentials', async () => {
            const res = await request(app)
                .post('/api/v1/auth/login')
                .send({
                    email: testUser.email,
                    password: testUser.password
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.token).toBeDefined();
        });

        it('should fail login with invalid password', async () => {
            const res = await request(app)
                .post('/api/v1/auth/login')
                .send({
                    email: testUser.email,
                    password: 'wrongpassword'
                });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Invalid credentials');
        });

        it('should lock account after 5 failed attempts', async () => {
            const email = `lockout_${Date.now()}@example.com`;
            // Register user first
            await request(app).post('/api/v1/auth/register').send({ ...testUser, email });

            // 5 failed attempts
            for (let i = 0; i < 5; i++) {
                await request(app)
                    .post('/api/v1/auth/login')
                    .send({ email, password: 'wrongpassword' });
            }

            // 6th attempt should be locked out
            const res = await request(app)
                .post('/api/v1/auth/login')
                .send({ email, password: 'wrongpassword' });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('Account locked');
        });
    });
});
