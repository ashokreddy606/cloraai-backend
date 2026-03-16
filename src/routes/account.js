const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Account Activity Endpoint
router.get('/activity', authenticate, authController.getSessions);

// Logout Specific Session
router.post('/logout-session', authenticate, authController.logoutSession);

module.exports = router;
