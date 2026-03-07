const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const youtubeController = require('../controllers/youtubeController');
const checkProAccess = require('../middleware/checkProAccess');

// ── OAuth Flow ─────────────────────────────────────────────────────────────
// GET /api/youtube/auth
// Start the OAuth flow. Returns URL to Google OAuth.
router.get('/auth', authenticate, youtubeController.getAuthUrl);

// GET /api/youtube/callback
// Handle Google OAuth callback and save tokens
router.get('/callback', youtubeController.handleCallback); // Note: Removed requireAuth for callback to allow Google redirect

// GET /api/youtube/status
// Get connection status and basic channel info
router.get('/status', authenticate, youtubeController.getStatus);

// DELETE /api/youtube/disconnect
// Disconnect YouTube account
router.delete('/disconnect', authenticate, youtubeController.disconnect);

// ── Automation Rules ───────────────────────────────────────────────────────
// GET /api/youtube/rules
router.get('/rules', authenticate, checkProAccess, youtubeController.getRules);

// POST /api/youtube/rules
router.post('/rules', authenticate, checkProAccess, youtubeController.createRule);

// PUT /api/youtube/rules/:id
router.put('/rules/:id', authenticate, checkProAccess, youtubeController.updateRule);

// DELETE /api/youtube/rules/:id
router.delete('/rules/:id', authenticate, checkProAccess, youtubeController.deleteRule);

// ── Leads ──────────────────────────────────────────────────────────────────
// GET /api/youtube/leads
router.get('/leads', authenticate, youtubeController.getLeads);

// POST /api/youtube/leads
// Public endpoint for submitting a lead form (no auth required)
router.post('/leads/submit', youtubeController.submitLead);

// ── Analytics ──────────────────────────────────────────────────────────────
// GET /api/youtube/analytics
router.get('/analytics', authenticate, checkProAccess, youtubeController.getAnalytics);

module.exports = router;
