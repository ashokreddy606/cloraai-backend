const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');

router.get('/dashboard', authenticate, checkProAccess, analyticsController.getDashboard);
router.post('/snapshot', authenticate, checkProAccess, analyticsController.recordSnapshot);
router.get('/monthly', authenticate, checkProAccess, analyticsController.getMonthlyAnalytics);

module.exports = router;
