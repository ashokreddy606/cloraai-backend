const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const youtubeController = require('../controllers/youtubeController');
const instagramController = require('../controllers/instagramController');
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

router.post('/reset-password/:token',
    authLimiterForgot,
    validate(resetPasswordSchema),
    authController.resetPassword
);


router.post('/refresh-token', authController.refreshToken);
router.get('/me', authenticate, authController.getCurrentUser);
router.put('/profile', authenticate, validate(require('../validators/user').updateProfileSchema), authController.updateProfile);
router.post('/verify-email', authController.verifyEmail);
router.post('/logout', authenticate, authController.logout);
router.delete('/account', authenticate, authController.deleteAccount);

// Admin promotion endpoint (requires authentication + admin role + secret key)
router.post('/make-admin',
    authenticate,
    require('../middleware/auth').requireAdmin,
    validate(require('zod').object({ body: require('zod').object({ email: require('zod').string().email(), secretKey: require('zod').string().min(1) }) })),
    authController.makeAdmin
);

// 2FA Routes
router.post('/setup-2fa', authenticate, authController.setup2FA);
router.post('/verify-2fa', authenticate, authController.verify2FA);

// Meta OAuth Callbacks
router.get('/facebook/callback', authController.facebookCallback);
router.get('/instagram', instagramController.initiateAuth);
router.get('/instagram/callback', instagramController.handleOAuthCallback);
router.get('/youtube/callback', youtubeController.handleCallback);

// Session Management
router.get('/sessions', authenticate, authController.getSessions);
router.delete('/sessions/:sessionId', authenticate, authController.logoutSession);
router.post('/logout-all', authenticate, authController.logoutAllDevices);

module.exports = router;
