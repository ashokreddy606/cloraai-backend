const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const youtubeController = require('../controllers/youtubeController');
const { youtubeGuard, youtubeAutomationGuard } = require('../middleware/youtubeGuard');
const checkProAccess = require('../middleware/checkProAccess');
const { uploadVideoS3 } = require('../middleware/upload');
const checkUploadLimit = require('../middleware/checkUploadLimit');

router.use(youtubeGuard);

// ── OAuth Flow ─────────────────────────────────────────────────────────────
router.get('/auth', authenticate, youtubeController.getAuthUrl);
router.get('/callback', youtubeController.handleCallback);
router.get('/status', authenticate, youtubeController.getStatus);
router.delete('/disconnect', authenticate, youtubeController.disconnect);

// ── Automation Rules ───────────────────────────────────────────────────────
router.get('/rules', authenticate, checkProAccess, youtubeController.getRules);
router.post('/rules', authenticate, checkProAccess, youtubeController.createRule);
router.put('/rules/:id', authenticate, checkProAccess, youtubeController.updateRule);
router.delete('/rules/:id', authenticate, checkProAccess, youtubeController.deleteRule);

// ── Leads ──────────────────────────────────────────────────────────────────
router.get('/leads', authenticate, youtubeController.getLeads);
// FIX: Add authentication middleware to submitLead
router.post('/leads/submit', authenticate, youtubeController.submitLead);

// ── Analytics ──────────────────────────────────────────────────────────────
router.get('/analytics', authenticate, checkProAccess, youtubeController.getAnalytics);

// ── Channel Analytics (Real YouTube Data API) ─────────────────────────────
router.get('/channel-analytics', authenticate, youtubeController.getChannelAnalytics);

// ── Video Management ──────────────────────────────────────────────────────
// GET  /api/youtube/videos  — list user's channel videos
router.get('/videos', authenticate, youtubeController.getUserVideos);

// POST /api/youtube/videos/upload — upload a new video
router.post('/videos/upload', authenticate, checkUploadLimit, uploadVideoS3.single('video'), youtubeController.uploadVideo);

// PUT  /api/youtube/videos/:videoId — update video metadata
router.put('/videos/:videoId', authenticate, youtubeController.updateVideo);

// DELETE /api/youtube/videos/:videoId — delete a video
router.delete('/videos/:videoId', authenticate, youtubeController.deleteVideo);

// GET /api/youtube/videos/:videoId/analytics — detailed video analytics
router.get('/videos/:videoId/analytics', authenticate, youtubeController.getVideoAnalytics);

module.exports = router;
