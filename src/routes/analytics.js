const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');
const { cacheRoute } = require('../utils/cache');
const validate = require('../middleware/validate');
const { recordSnapshotSchema, getMonthlyAnalyticsSchema } = require('../validators/analytics');

router.get('/dashboard', authenticate, checkProAccess, cacheRoute(300, 'analytics'), analyticsController.getDashboard);
router.post('/snapshot', authenticate, checkProAccess, validate(recordSnapshotSchema), analyticsController.recordSnapshot);
router.get('/monthly', authenticate, checkProAccess, cacheRoute(300, 'analytics'), validate(getMonthlyAnalyticsSchema), analyticsController.getMonthlyAnalytics);
// Debug routes ONLY available in Development or for Admin
router.get('/debug', authenticate, (req, res, next) => {
    // Security Restriction: Debug endpoints expose internal Meta API objects
    if (process.env.NODE_ENV !== 'production' || req.user?.role === 'ADMIN') {
        return analyticsController.debugViews(req, res, next);
    }
    res.status(403).json({ 
        error: 'Forbidden', 
        message: 'Debug access is disabled in production environments for non-admin accounts.' 
    });
});


module.exports = router;
