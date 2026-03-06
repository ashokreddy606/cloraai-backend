const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const youtubeController = require('../controllers/youtubeController');

// ── OAuth Flow ─────────────────────────────────────────────────────────────
// GET /api/youtube/auth
// Start the OAuth flow. Redirects user to Google.
router.get('/auth', requireAuth, youtubeController.getAuthUrl);

// GET /api/youtube/callback
// Handle Google OAuth callback and save tokens
router.get('/callback', requireAuth, youtubeController.handleCallback);

// GET /api/youtube/status
// Get connection status and basic channel info
router.get('/status', requireAuth, youtubeController.getStatus);

// DELETE /api/youtube/disconnect
// Disconnect YouTube account
router.delete('/disconnect', requireAuth, youtubeController.disconnect);

// ── Automation Rules ───────────────────────────────────────────────────────
// GET /api/youtube/rules
router.get('/rules', requireAuth, youtubeController.getRules);

// POST /api/youtube/rules
router.post('/rules', requireAuth, youtubeController.createRule);

// PUT /api/youtube/rules/:id
router.put('/rules/:id', requireAuth, youtubeController.updateRule);

// DELETE /api/youtube/rules/:id
router.delete('/rules/:id', requireAuth, youtubeController.deleteRule);

// ── Leads ──────────────────────────────────────────────────────────────────
// GET /api/youtube/leads
router.get('/leads', requireAuth, youtubeController.getLeads);

// POST /api/youtube/leads
// Public endpoint for submitting a lead form (no auth required)
router.post('/leads/submit', youtubeController.submitLead);

// ── Analytics ──────────────────────────────────────────────────────────────
// GET /api/youtube/analytics
router.get('/analytics', requireAuth, youtubeController.getAnalytics);

module.exports = router;
