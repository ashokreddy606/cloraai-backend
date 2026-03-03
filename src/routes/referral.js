const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referralController');
const { authenticate } = require('../middleware/auth');

router.get('/stats', authenticate, referralController.getReferralStats);

module.exports = router;
