const express = require('express');
const router = express.Router();
const schedulerController = require('../controllers/schedulerController');
const { authenticate } = require('../middleware/auth');
const checkUploadLimit = require('../middleware/checkUploadLimit');

// Scheduler
router.post('/schedule', authenticate, checkUploadLimit, schedulerController.schedulePost);
router.get('/posts', authenticate, schedulerController.getScheduledPosts);
router.delete('/:id', authenticate, schedulerController.cancelPost);

module.exports = router;
