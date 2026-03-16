const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Account Activity Endpoint (Alias for /auth/sessions with specific format)
router.get('/activity', authenticate, authController.getSessions);

module.exports = router;
