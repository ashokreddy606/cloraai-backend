const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { logoutSessionSchema } = require('../validators/user');

// Account Activity Endpoint
router.get('/activity', authenticate, authController.getSessions);

// Logout Specific Session
router.post('/logout-session', authenticate, validate(logoutSessionSchema), authController.logoutSession);

module.exports = router;
