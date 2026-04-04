const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const youtubeController = require('../controllers/youtubeController');
const { youtubeGuard, youtubeAutomationGuard } = require('../middleware/youtubeGuard');
const checkProAccess = require('../middleware/checkProAccess');
const validate = require('../middleware/validate');
const { createRuleSchema, updateRuleSchema } = require('../validators/youtube');

const logger = require('../utils/logger');

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
router.get('/rules', authenticate, checkProAccess, youtubeController.getRules);
router.post('/rules', authenticate, checkProAccess, validate(createRuleSchema), youtubeController.createRule);
router.put('/rules/:id', authenticate, checkProAccess, validate(updateRuleSchema), verifyResourceOwnership('youtubeAutomationRule'), youtubeController.updateRule);
router.delete('/rules/:id', authenticate, checkProAccess, verifyResourceOwnership('youtubeAutomationRule'), youtubeController.deleteRule);

// ── Analytics ──────────────────────────────────────────────────────────────
router.get('/analytics', authenticate, checkProAccess, youtubeController.getAnalytics);

// ── Channel Analytics (Real YouTube Data API) ─────────────────────────────
router.get('/channel-analytics', authenticate, youtubeController.getChannelAnalytics);

module.exports = router;
