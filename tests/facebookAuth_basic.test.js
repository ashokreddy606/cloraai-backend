const { facebookCallback } = require('../src/controllers/authController');

describe('authController.facebookCallback', () => {
    let fetchSpy;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.FACEBOOK_APP_ID = 'test_app_id';
        process.env.FACEBOOK_APP_SECRET = 'test_app_secret';

        if (typeof global.fetch === 'undefined') {
            global.fetch = jest.fn();
        }
        fetchSpy = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        process.env = { ...originalEnv };
    });

    it('should call next with error if code is missing', async () => {
        const req = { query: {} };
        const res = {};
        const next = jest.fn();

        await facebookCallback(req, res, next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 400,
            message: 'No code provided from Facebook OAuth'
        }));
    });

    it('should call next with error if FB env vars are missing', async () => {
        delete process.env.FACEBOOK_APP_ID;
        const req = { query: { code: 'test_code' } };
        const res = {};
        const next = jest.fn();

        await facebookCallback(req, res, next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 500,
            message: 'Facebook authentication is not configured on this server'
        }));
    });

    it('should exchange code for access token successfully', async () => {
        const req = { query: { code: 'test_code' } };
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        const next = jest.fn();

        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ access_token: 'mock_access_token' })
        });

        await facebookCallback(req, res, next);

        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('code=test_code')
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            access_token: 'mock_access_token'
        });
        expect(next).not.toHaveBeenCalled();
    });

    it('should call next with error handling Facebook API errors', async () => {
        const req = { query: { code: 'test_code' } };
        const res = {};
        const next = jest.fn();

        fetchSpy.mockResolvedValueOnce({
            ok: false,
            json: async () => ({ error: { message: 'Invalid code' } })
        });

        await facebookCallback(req, res, next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 401,
            message: 'Invalid code'
        }));
    });
});
