const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagramController');
const { authenticate } = require('../middleware/auth');

const { uploadVideoS3, uploadTempVideo, validateFileContent } = require('../middleware/upload');

// OAuth Flows
router.get('/initiate', instagramController.initiateAuth);
router.get('/callback', instagramController.handleOAuthCallback);

// Reel Upload (Synchronous/Reliable)
router.post('/upload-reel', authenticate, uploadTempVideo.single('file'), validateFileContent, instagramController.uploadAndPostReel);

// Account & Analytics
router.get('/account', authenticate, instagramController.getAccountDetails);
router.post('/disconnect', authenticate, instagramController.disconnectAccount);
router.get('/stats', authenticate, instagramController.getAnalytics);
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
