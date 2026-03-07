const request = require('supertest');
const app = require('../server'); // Assumes server exports the Express app without listening directly if used in tests
const prisma = require('../src/lib/prisma');

// If server.js starts listening automatically, this is a bit tricky, but we can just test the local instance if it's already running or mock the `listen`
// For simplicity, we assume server.js exports the app.

describe('System Endpoints', () => {

    it('should return 200 on /health', async () => {
        const response = await request(app).get('/health');
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
    });

    it('should block /internal/metrics without correct token', async () => {
        const response = await request(app).get('/internal/metrics');
        // Expect either 401 Unauthorized or 503 if not configured
        expect([401, 503]).toContain(response.status);
    });

    it('should allow /internal/metrics with correct token', async () => {
        process.env.INTERNAL_METRICS_TOKEN = 'test_token';
        const response = await request(app)
            .get('/internal/metrics')
            .set('x-internal-token', 'test_token');

        expect(response.status).toBe(200);
        expect(response.type).toMatch(/text\/plain/);
    });
});

afterAll(async () => {
    await prisma.$disconnect();
});
