const express = require('express');
const router = express.Router();
const dmAutomationController = require('../controllers/dmAutomationController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');

// 🔒 PRO ONLY: DM Automation
router.post('/rules', authenticate, checkProAccess, dmAutomationController.createRule);
router.get('/rules', authenticate, checkProAccess, dmAutomationController.getRules);
router.put('/rules/:id', authenticate, checkProAccess, dmAutomationController.updateRule);
router.delete('/rules/:id', authenticate, checkProAccess, dmAutomationController.deleteRule);

module.exports = router;

