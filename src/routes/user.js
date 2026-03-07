const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');

router.delete('/delete-account', authenticate, userController.deleteAccount);

module.exports = router;
