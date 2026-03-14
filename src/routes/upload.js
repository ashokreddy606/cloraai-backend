const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { authenticate } = require('../middleware/auth');
const { uploadVideoS3, uploadLocal, validateFileContent } = require('../middleware/upload');
const rateLimit = require('express-rate-limit');

// Prevent abuse of S3 generation (generating too many URLs costs money and flags AWS alerts)
const uploadLimiter = (process.env.NODE_ENV === 'test')
    ? (req, res, next) => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 50, // Hardened from 200 to 50
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many upload requests. Please try again later.' }
    });

// Direct file upload to local storage (Secured with magic-byte validation)
router.post('/local', authenticate, uploadLimiter, uploadLocal.single('file'), validateFileContent, uploadController.localUpload);

// File upload to S3 (Secured with magic-byte validation)
router.post('/s3', authenticate, uploadLimiter, uploadVideoS3.single('file'), validateFileContent, uploadController.s3Upload);

module.exports = router;
