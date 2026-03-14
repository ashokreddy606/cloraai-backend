const express = require('express');
const router = express.Router();
const dmAutomationController = require('../controllers/dmAutomationController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');
const verifyResourceOwnership = require('../middleware/ownership');

// 🔒 PRO ONLY: DM Automation
router.post('/rules', authenticate, checkProAccess, dmAutomationController.createRule);
router.get('/rules', authenticate, checkProAccess, dmAutomationController.getRules);

// Protected by ownership check to prevent IDOR
router.put('/rules/:id', authenticate, checkProAccess, verifyResourceOwnership('dMAutomation'), dmAutomationController.updateRule);
router.delete('/rules/:id', authenticate, checkProAccess, verifyResourceOwnership('dMAutomation'), dmAutomationController.deleteRule);

module.exports = router;

