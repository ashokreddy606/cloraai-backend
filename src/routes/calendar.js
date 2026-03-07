const express = require('express');
const router = express.Router();
const calendarController = require('../controllers/calendarController');
const { authenticate, rateLimit } = require('../middleware/auth');
const { cacheRoute } = require('../utils/cache');

const aiRateLimit = rateLimit(30, 60, (req) => req.userId || req.ip);

router.get('/tasks', authenticate, cacheRoute(60, 'calendar'), calendarController.getTasks);
router.post('/tasks', authenticate, calendarController.createTask);
router.patch('/tasks/:id/toggle', authenticate, calendarController.toggleTask);
router.delete('/tasks/:id', authenticate, calendarController.deleteTask);

// Auto Calendar Routes
router.post('/generate', authenticate, aiRateLimit, calendarController.generateCalendar);
router.get('/view', authenticate, cacheRoute(300, 'calendar'), calendarController.getCalendar);
router.get('/ideas', authenticate, aiRateLimit, cacheRoute(3600, 'calendar'), calendarController.getCalendarIdeas);

module.exports = router;
