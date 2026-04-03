const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { registerPushTokenSchema, markNotificationReadSchema } = require('../validators/user');
const verifyResourceOwnership = require('../middleware/ownership');

router.post('/register-token', authenticate, validate(registerPushTokenSchema), notificationController.registerToken);
router.get('/', authenticate, notificationController.getNotifications);
router.patch('/read-all', authenticate, notificationController.markAllRead);
router.patch('/:id/read', authenticate, validate(markNotificationReadSchema), verifyResourceOwnership('notification'), notificationController.markAsRead);
router.delete('/:id', authenticate, verifyResourceOwnership('notification'), notificationController.deleteNotification);
router.delete('/', authenticate, notificationController.clearNotifications);
router.post('/bulk-delete', authenticate, notificationController.deleteBulkNotifications);

module.exports = router;
