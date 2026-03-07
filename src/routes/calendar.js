const express = require('express');
const router = express.Router();
const calendarController = require('../controllers/calendarController');
const { authenticate } = require('../middleware/auth');

router.get('/tasks', authenticate, calendarController.getTasks);
router.post('/tasks', authenticate, calendarController.createTask);
router.patch('/tasks/:id/toggle', authenticate, calendarController.toggleTask);
router.delete('/tasks/:id', authenticate, calendarController.deleteTask);

// Auto Calendar Routes
router.post('/generate', authenticate, calendarController.generateCalendar);
router.get('/view', authenticate, calendarController.getCalendar);
router.get('/ideas', authenticate, calendarController.getCalendarIdeas);

module.exports = router;
