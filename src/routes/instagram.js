const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagramController');
const { authenticate } = require('../middleware/auth');

// OAuth Flows
router.get('/initiate', authenticate, instagramController.initiateAuth);
router.post('/callback', authenticate, instagramController.handleOAuthCallback);

// Account & Analytics
router.get('/account', authenticate, instagramController.getAccountDetails);
router.post('/disconnect', authenticate, instagramController.disconnectAccount);
router.get('/stats', authenticate, instagramController.getStats);
router.get('/media', authenticate, instagramController.getPosts);
router.get('/media/:mediaId/insights', authenticate, instagramController.getPostInsights);
// For historical trend data (stored in Mongoose)
router.get('/history', authenticate, async (req, res) => {
    try {
        const InstagramAnalytics = require('../../models/InstagramAnalytics');
        const history = await InstagramAnalytics.find({ userId: req.userId }).sort({ date: 1 });
        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
