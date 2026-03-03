const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, rateLimit } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { registerSchema, loginSchema, resetPasswordSchema, googleAuthSchema } = require('../validators/auth');

// Rate limiting for auth endpoints
const authRateLimit = rateLimit(30, 15 * 60 * 1000); // 30 requests per 15 minutes
// Specialized stricter rate limit for Auth to prevent brute force (15 attempts / 15 mins)
const authLimiter = rateLimit(15, 15 * 60 * 1000);

router.post('/register',
    authLimiter,
    validate(registerSchema),
    authController.register
);

router.post('/login',
    authLimiter,
    validate(loginSchema),
    authController.login
);

router.post('/google',
    authRateLimit,
    validate(googleAuthSchema),
    authController.googleAuth
);

router.post('/forgot-password',
    authRateLimit,
    // Reuse email logic directly here without a separate file for a single field
    validate(require('zod').object({ body: require('zod').object({ email: require('zod').string().email('Valid email is required') }) })),
    authController.forgotPassword
);

router.post('/reset-password',
    authRateLimit,
    validate(resetPasswordSchema),
    authController.resetPassword
);

router.get('/me', authenticate, authController.getCurrentUser);
router.put('/profile', authenticate, authController.updateProfile);
router.post('/logout', authenticate, authController.logout);
router.delete('/account', authenticate, authController.deleteAccount);

// One-time admin promotion endpoint (requires secret key)
router.post('/make-admin',
    validate(require('zod').object({ body: require('zod').object({ email: require('zod').string().email(), secretKey: require('zod').string().min(1) }) })),
    authController.makeAdmin
);

module.exports = router;
