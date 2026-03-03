const express = require('express');
const router = express.Router();
const schedulerController = require('../controllers/schedulerController');
const { authenticate } = require('../middleware/auth');

// Scheduler (Limits handled in controller: Free users get 4/month)
router.post('/schedule', authenticate, schedulerController.schedulePost);
router.get('/posts', authenticate, schedulerController.getScheduledPosts);
router.delete('/:id', authenticate, schedulerController.cancelPost);

module.exports = router;
