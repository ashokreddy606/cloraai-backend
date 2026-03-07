const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { authenticate } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Prevent abuse of S3 generation (generating too many URLs costs money and flags AWS alerts)
const uploadLimiter = (process.env.NODE_ENV === 'test')
    ? (req, res, next) => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 200, // Reverting to safe default for now
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many upload requests. Please try again later.' }
    });

router.post('/presigned-url', authenticate, uploadLimiter, uploadController.generatePresignedUrl);

module.exports = router;
