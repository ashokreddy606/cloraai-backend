const express = require('express');
const router = express.Router();
const brandDealController = require('../controllers/brandDealController');
const { authenticate, rateLimit } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');

const aiRateLimit = rateLimit(30, 60, (req) => req.userId || req.ip);

// 🔒 PRO ONLY: Brand Deal Detection
router.get('/', authenticate, checkProAccess, brandDealController.getBrandDeals);
router.post('/simulate', authenticate, checkProAccess, aiRateLimit, brandDealController.simulateIncomingDM);

// User Interactions
router.post('/:id/ignore', authenticate, checkProAccess, brandDealController.ignoreDeal);
router.post('/:id/reply', authenticate, checkProAccess, aiRateLimit, brandDealController.replyToDeal);

module.exports = router;

