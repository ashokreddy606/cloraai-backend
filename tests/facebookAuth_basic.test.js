const { facebookCallback } = require('../src/controllers/authController');
const instagramService = require('../src/services/instagramService');
const prisma = require('../src/lib/prisma');
const InstagramAccountMongoose = require('../models/InstagramAccount');
const axios = require('axios');

jest.mock('../src/services/instagramService');
jest.mock('../src/lib/prisma', () => ({
    instagramAccount: {
        upsert: jest.fn(),
    },
}));
jest.mock('../models/InstagramAccount');
jest.mock('axios');

describe('authController.facebookCallback', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.FACEBOOK_APP_ID = 'test_app_id';
        process.env.FACEBOOK_APP_SECRET = 'test_app_secret';
        process.env.FRONTEND_URL = 'http://localhost:8081';
        process.env.META_GRAPH_API_VERSION = 'v18.0';
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('should redirect back with instagram_connected=true on success', async () => {
        const userId = 'user123';
        const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
        const req = { query: { code: 'test_code', state } };
        const res = {
            redirect: jest.fn()
        };
        const next = jest.fn();

        instagramService.exchangeCodeForToken.mockResolvedValue({
            accessToken: 'long_lived_token',
            expiresIn: 3600
        });

        instagramService.getBusinessAccount.mockResolvedValue({
            instagramBusinessAccountId: 'ig123',
            facebookPageId: 'page123'
        });

        axios.get.mockResolvedValue({
            data: { username: 'testuser' }
        });

        await facebookCallback(req, res, next);

        if (res.redirect.mock.calls.length > 0) {
            console.log('Actual Redirect Call:', res.redirect.mock.calls[0][0]);
        } else {
            console.log('No redirect called');
        }

        expect(res.redirect).toHaveBeenCalled();
        expect(res.redirect.mock.calls[0][0]).toContain('instagram_connected=true');
    });

    it('should redirect back with error on failure', async () => {
        const req = { query: { code: 'test_code' } };
        const res = {
            redirect: jest.fn()
        };
        const next = jest.fn();

        instagramService.exchangeCodeForToken.mockRejectedValue(new Error('API Error'));

        await facebookCallback(req, res, next);

        expect(res.redirect).toHaveBeenCalled();
        expect(res.redirect.mock.calls[0][0]).toContain('error=instagram_connection_failed');
    });
});
