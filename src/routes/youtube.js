const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const youtubeController = require('../controllers/youtubeController');
const { youtubeGuard, youtubeAutomationGuard } = require('../middleware/youtubeGuard');
const checkProAccess = require('../middleware/checkProAccess');
const { uploadVideoS3 } = require('../middleware/upload');
const checkUploadLimit = require('../middleware/checkUploadLimit');
const validate = require('../middleware/validate');
const { createRuleSchema, updateRuleSchema } = require('../validators/youtube');

router.use(youtubeGuard);

// ── OAuth Flow ─────────────────────────────────────────────────────────────
router.get('/auth', authenticate, youtubeController.getAuthUrl);
router.get('/callback', youtubeController.handleCallback);
router.get('/status', authenticate, youtubeController.getStatus);
router.delete('/disconnect', authenticate, youtubeController.disconnect);

// ── Automation Rules (validated) ───────────────────────────────────────────
router.get('/rules', authenticate, checkProAccess, youtubeController.getRules);
router.post('/rules', authenticate, checkProAccess, validate(createRuleSchema), youtubeController.createRule);
router.put('/rules/:id', authenticate, checkProAccess, validate(updateRuleSchema), youtubeController.updateRule);
router.delete('/rules/:id', authenticate, checkProAccess, youtubeController.deleteRule);

// ── Analytics ──────────────────────────────────────────────────────────────
router.get('/analytics', authenticate, checkProAccess, youtubeController.getAnalytics);

// ── Channel Analytics (Real YouTube Data API) ─────────────────────────────
router.get('/channel-analytics', authenticate, youtubeController.getChannelAnalytics);

module.exports = router;
