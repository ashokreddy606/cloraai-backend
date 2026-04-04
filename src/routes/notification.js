const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { registerDeviceSchema, markNotificationReadSchema } = require('../validators/user');

/**
 * Multi-device Notification Routes
 */

// Register/Update Device
router.post('/register-device', 
  authenticate, 
  validate(registerDeviceSchema), 
  notificationController.registerDevice
);

// Remove Device (Logout)
router.post('/remove-device', 
  authenticate, 
  notificationController.removeDevice
);

// List My Devices
router.get('/devices', 
  authenticate, 
  notificationController.getDevices
);

// Notification History
router.get('/', 
  authenticate, 
  notificationController.getNotifications
);

// Mark All Read
router.patch('/read-all', 
  authenticate, 
  notificationController.markAllRead
);

// Mark Single Read
router.patch('/:id/read', 
  authenticate, 
  validate(markNotificationReadSchema), 
  notificationController.markAsRead
);

// Send Test Notification (Admin only)
router.post('/test', 
  authenticate, 
  requireAdmin, 
  notificationController.sendTestNotification
);

module.exports = router;
