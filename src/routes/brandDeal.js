const express = require('express');
const router = express.Router();
const brandDealController = require('../controllers/brandDealController');
const { authenticate } = require('../middleware/auth');
const { requirePro } = require('../middleware/planGuard');

// 🔒 PRO ONLY: Brand Deal Detection
router.get('/', authenticate, requirePro, brandDealController.getBrandDeals);
router.post('/simulate', authenticate, requirePro, brandDealController.simulateIncomingDM);

// User Interactions
router.post('/:id/ignore', authenticate, requirePro, brandDealController.ignoreDeal);
router.post('/:id/reply', authenticate, requirePro, brandDealController.replyToDeal);

module.exports = router;

