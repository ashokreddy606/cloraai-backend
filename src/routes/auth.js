const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, rateLimit } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { registerSchema, loginSchema, resetPasswordSchema, googleAuthSchema } = require('../validators/auth');

// Strict brute-force protection specific to different auth actions
const { authLimiterLogin, authLimiterRegister, authLimiterForgot } = require('../middleware/auth');

router.post('/register',
    authLimiterRegister,
    validate(registerSchema),
    authController.register
);

router.post('/login',
    authLimiterLogin,
    validate(loginSchema),
    authController.login
);

router.post('/google',
    authLimiterLogin,
    validate(googleAuthSchema),
    authController.googleAuth
);

router.post('/forgot-password',
    authLimiterForgot,
    // Reuse email logic directly here without a separate file for a single field
    validate(require('zod').object({ body: require('zod').object({ email: require('zod').string().email('Valid email is required') }) })),
    authController.forgotPassword
);

router.post('/reset-password',
    authLimiterForgot,
    validate(resetPasswordSchema),
    authController.resetPassword
);

router.post('/refresh-token', authController.refreshToken);
router.get('/me', authenticate, authController.getCurrentUser);
router.put('/profile', authenticate, authController.updateProfile);
router.post('/verify-email', authController.verifyEmail);
router.post('/logout', authenticate, authController.logout);
router.delete('/account', authenticate, authController.deleteAccount);

// One-time admin promotion endpoint (requires secret key)
router.post('/make-admin',
    validate(require('zod').object({ body: require('zod').object({ email: require('zod').string().email(), secretKey: require('zod').string().min(1) }) })),
    authController.makeAdmin
);

// 2FA Routes
router.post('/setup-2fa', authenticate, authController.setup2FA);
router.post('/verify-2fa', authenticate, authController.verify2FA);

// Meta OAuth Callbacks
router.get('/facebook/callback', authController.facebookCallback);
router.get('/instagram', authController.instagramAuth);
router.get('/instagram/callback', authController.instagramCallback);

// Session Management
router.get('/sessions', authenticate, authController.getSessions);
router.delete('/sessions/:sessionId', authenticate, authController.logoutDevice);
router.post('/logout-all', authenticate, authController.logoutAllDevices);

module.exports = router;
