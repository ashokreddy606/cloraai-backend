const express = require('express');
const router = express.Router();
const captionController = require('../controllers/captionController');
const { authenticate, rateLimit } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/aiLimiter');
const checkProAccess = require('../middleware/checkProAccess');
const validate = require('../middleware/validate');
const { z } = require('zod');
const verifyResourceOwnership = require('../middleware/ownership');

// AI generation route limit: 30 per hour per user
const aiRateLimit = rateLimit(30, 60, (req) => req.userId || req.ip);

// AI Caption Generation (aiLimiter enforces Free=3/day, Pro=30/day, plus global budget)
router.post('/generate',
    authenticate,
    checkProAccess,
    aiLimiter('caption'),
    aiRateLimit,
    validate(z.object({
        body: z.object({
            topic: z.string().min(1, 'Topic is required').max(200, 'Topic is too long'),
            tone: z.string().min(1, 'Tone is required'),
            length: z.enum(['short', 'medium', 'long']).optional().default('medium')
        })
    })),
    captionController.generateCaption
);

// Free tier: read-only history access (Controller already filters by req.userId)
router.get('/history', authenticate, captionController.getCaptions);

// Protected by ownership check to prevent IDOR
router.delete('/:id', authenticate, verifyResourceOwnership('caption'), captionController.deleteCaption);
router.post('/:id/report', authenticate, verifyResourceOwnership('caption'), captionController.reportCaption);

module.exports = router;
