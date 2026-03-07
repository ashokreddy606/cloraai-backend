const express = require('express');
const router = express.Router();
const brandDealController = require('../controllers/brandDealController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');

// 🔒 PRO ONLY: Brand Deal Detection
router.get('/', authenticate, checkProAccess, brandDealController.getBrandDeals);
router.post('/simulate', authenticate, checkProAccess, brandDealController.simulateIncomingDM);

// User Interactions
router.post('/:id/ignore', authenticate, checkProAccess, brandDealController.ignoreDeal);
router.post('/:id/reply', authenticate, checkProAccess, brandDealController.replyToDeal);

module.exports = router;

