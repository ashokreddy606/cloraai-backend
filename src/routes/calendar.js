const express = require('express');
const router = express.Router();
const calendarController = require('../controllers/calendarController');
const { authenticate } = require('../middleware/auth');

router.get('/tasks', authenticate, calendarController.getTasks);
router.post('/tasks', authenticate, calendarController.createTask);
router.patch('/tasks/:id/toggle', authenticate, calendarController.toggleTask);
router.delete('/tasks/:id', authenticate, calendarController.deleteTask);

module.exports = router;
