const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
    getNotifications,
    registerToken,
    markRead,
    dismissNotification,
    clearAll,
} = require('../controllers/notificationController');

router.get('/', authenticate, getNotifications);
router.post('/register-token', authenticate, registerToken);
router.patch('/:id/read', authenticate, markRead);
router.delete('/clear-all', authenticate, clearAll);
router.delete('/:id', authenticate, dismissNotification);

module.exports = router;
