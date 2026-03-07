const express = require('express');
const router = express.Router();
const captionController = require('../controllers/captionController');
const { authenticate, rateLimit } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/aiLimiter');
const checkProAccess = require('../middleware/checkProAccess');
const validate = require('../middleware/validate');
const { z } = require('zod');

// 10 generations per 15 mins to protect OpenAI credits
const aiRateLimit = rateLimit(10, 15); // 10 requests per 15 minutes

// AI Caption Generation (aiLimiter enforces Free=3/day, Pro=30/day, plus global budget)
router.post('/generate',
    authenticate,
    checkProAccess,
    aiLimiter('caption'),  // ← replaces manual plan check in controller
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

// Free tier: read-only history access
router.get('/history', authenticate, captionController.getCaptions);
router.delete('/:id', authenticate, captionController.deleteCaption);

module.exports = router;

