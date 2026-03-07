const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const { authenticate } = require('../middleware/auth');

router.post('/bulk-schedule', authenticate, postController.bulkSchedule);

module.exports = router;
