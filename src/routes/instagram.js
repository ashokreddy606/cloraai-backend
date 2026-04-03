const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagramController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { getPostInsightsSchema, oauthCallbackSchema } = require('../validators/instagram');

// OAuth Flows (initiate requires auth to prevent account hijacking)
router.get('/initiate', authenticate, instagramController.initiateAuth);
router.get('/callback', validate(oauthCallbackSchema), instagramController.handleOAuthCallback);

// Account & Analytics
router.get('/account', authenticate, instagramController.getAccountDetails);
router.post('/disconnect', authenticate, instagramController.disconnectAccount);
router.get('/stats', authenticate, instagramController.getAnalytics);
router.get('/media', authenticate, instagramController.getPosts);
router.get('/media/:mediaId/insights', authenticate, validate(getPostInsightsSchema), instagramController.getPostInsights);

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
