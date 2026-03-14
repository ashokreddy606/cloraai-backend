const express = require('express');
const router = express.Router();
const calendarController = require('../controllers/calendarController');
const { authenticate, rateLimit } = require('../middleware/auth');
const { cacheRoute } = require('../utils/cache');

const verifyResourceOwnership = require('../middleware/ownership');

const aiRateLimit = rateLimit(30, 60, (req) => req.userId || req.ip);

router.get('/tasks', authenticate, cacheRoute(60, 'calendar'), calendarController.getTasks);
router.post('/tasks', authenticate, calendarController.createTask);
// Debug routes only available in Development or for Admin
router.get('/debug', authenticate, (req, res, next) => {
    if (process.env.NODE_ENV !== 'production' || req.userRole === 'ADMIN') {
        return analyticsController.debugViews(req, res, next);
    }
    res.status(403).json({ error: 'Forbidden', message: 'Debug access is disabled in production.' });
});

// Protected by ownership check to prevent IDOR
router.patch('/tasks/:id/toggle', authenticate, verifyResourceOwnership('calendarTask'), calendarController.toggleTask);
router.delete('/tasks/:id', authenticate, verifyResourceOwnership('calendarTask'), calendarController.deleteTask);

// Auto Calendar Routes
router.post('/generate', authenticate, aiRateLimit, calendarController.generateCalendar);
router.get('/view', authenticate, cacheRoute(300, 'calendar'), calendarController.getCalendar);
router.get('/ideas', authenticate, aiRateLimit, cacheRoute(3600, 'calendar'), calendarController.getCalendarIdeas);

module.exports = router;
