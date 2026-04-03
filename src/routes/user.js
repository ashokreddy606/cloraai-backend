const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { markNotificationReadSchema } = require('../validators/user');

router.delete('/delete-account', authenticate, userController.deleteAccount);
router.get('/notifications', authenticate, userController.getNotifications);
router.patch('/notifications/:id/read', authenticate, validate(markNotificationReadSchema), userController.markNotificationRead);

module.exports = router;
