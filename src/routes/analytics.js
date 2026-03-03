const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { authenticate } = require('../middleware/auth');

router.get('/dashboard', authenticate, analyticsController.getDashboard);
router.post('/snapshot', authenticate, analyticsController.recordSnapshot);
router.get('/monthly', authenticate, analyticsController.getMonthlyAnalytics);

module.exports = router;
