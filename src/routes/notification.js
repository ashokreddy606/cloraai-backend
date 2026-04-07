const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { registerDeviceSchema, markNotificationReadSchema, bulkDeleteNotificationsSchema } = require('../validators/user');

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

// Bulk Delete Notifications
router.post('/bulk-delete', 
  authenticate, 
  validate(bulkDeleteNotificationsSchema),
  notificationController.bulkDelete
);

// Clear All Notifications
router.delete('/', 
  authenticate, 
  notificationController.deleteAll
);

// Delete Single Notification
router.delete('/:id', 
  authenticate, 
  validate(markNotificationReadSchema), // Reusing schema since it just validates ObjectID in params
  notificationController.deleteNotification
);

// Send Test Notification (Admin only)
router.post('/test', 
  authenticate, 
  requireAdmin, 
  notificationController.sendTestNotification
);

// Health Check (Queue/Worker Monitoring)
router.get('/health', 
  authenticate, 
  requireAdmin, 
  notificationController.getHealth
);

module.exports = router;
