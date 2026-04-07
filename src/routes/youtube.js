const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const youtubeController = require('../controllers/youtubeController');
const { youtubeGuard, youtubeAutomationGuard } = require('../middleware/youtubeGuard');
const checkProAccess = require('../middleware/checkProAccess');
const validate = require('../middleware/validate');
const { createRuleSchema, updateRuleSchema } = require('../validators/youtube');

const logger = require('../utils/logger');
const verifyResourceOwnership = require('../middleware/ownership');

router.use(youtubeGuard);

// ── Videos (Picker) ──────────────────────────────────────────────────────
router.get('/videos', (req, res, next) => {
    logger.info('YOUTUBE', 'FETCH_VIDEOS_ROUTER_HIT', { path: req.path });
    next();
}, authenticate, youtubeController.getUserVideos);

// ── OAuth Flow ─────────────────────────────────────────────────────────────
router.get('/auth', authenticate, youtubeController.getAuthUrl);
router.get('/callback', youtubeController.handleCallback);
router.get('/status', authenticate, youtubeController.getStatus);
router.delete('/disconnect', authenticate, youtubeController.disconnect);

// ── Automation Rules (validated) ───────────────────────────────────────────
// Quotas (5 for Free, Unlimited for Pro) are handled inside the controller.
router.get('/rules', authenticate, youtubeController.getRules);
router.post('/rules', authenticate, validate(createRuleSchema), youtubeController.createRule);
router.put('/rules/:id', authenticate, validate(updateRuleSchema), verifyResourceOwnership('youtubeAutomationRule'), youtubeController.updateRule);
router.delete('/rules/:id', authenticate, verifyResourceOwnership('youtubeAutomationRule'), youtubeController.deleteRule);

// ── Analytics ──────────────────────────────────────────────────────────────
router.get('/analytics', authenticate, youtubeController.getAnalytics);

// ── Channel Analytics (Real YouTube Data API) ─────────────────────────────
router.get('/channel-analytics', authenticate, youtubeController.getChannelAnalytics);

module.exports = router;
