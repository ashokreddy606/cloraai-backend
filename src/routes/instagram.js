const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagramController');
const { authenticate } = require('../middleware/auth');

router.get('/oauth-url', authenticate, instagramController.getOAuthUrl);
router.post('/oauth-callback', authenticate, instagramController.handleOAuthCallback);
router.get('/account', authenticate, instagramController.getAccountDetails);
router.post('/disconnect', authenticate, instagramController.disconnectAccount);

module.exports = router;
