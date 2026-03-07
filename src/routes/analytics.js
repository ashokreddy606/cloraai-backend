const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');
const { cacheRoute } = require('../utils/cache');

router.get('/dashboard', authenticate, checkProAccess, cacheRoute(300, 'analytics'), analyticsController.getDashboard);
router.post('/snapshot', authenticate, checkProAccess, analyticsController.recordSnapshot);
router.get('/monthly', authenticate, checkProAccess, cacheRoute(300, 'analytics'), analyticsController.getMonthlyAnalytics);

module.exports = router;
