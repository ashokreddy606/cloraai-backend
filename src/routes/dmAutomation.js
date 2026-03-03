const express = require('express');
const router = express.Router();
const dmAutomationController = require('../controllers/dmAutomationController');
const { authenticate } = require('../middleware/auth');
const { requirePro } = require('../middleware/planGuard');

// 🔒 PRO ONLY: DM Automation
router.post('/rules', authenticate, requirePro, dmAutomationController.createRule);
router.get('/rules', authenticate, requirePro, dmAutomationController.getRules);
router.put('/rules/:id', authenticate, requirePro, dmAutomationController.updateRule);
router.delete('/rules/:id', authenticate, requirePro, dmAutomationController.deleteRule);

module.exports = router;

