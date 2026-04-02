const express = require('express');
const router = express.Router();
const dmAutomationController = require('../controllers/dmAutomationController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');
const verifyResourceOwnership = require('../middleware/ownership');
const validate = require('../middleware/validate');
const { createRuleSchema, updateRuleSchema } = require('../validators/dmAutomation');

// 🔒 PRO ONLY: DM Automation
router.post('/rules', authenticate, checkProAccess, validate(createRuleSchema), dmAutomationController.createRule);
router.get('/rules', authenticate, checkProAccess, dmAutomationController.getRules);

// Protected by ownership check to prevent IDOR + input validation
router.put('/rules/:id', authenticate, checkProAccess, validate(updateRuleSchema), verifyResourceOwnership('dMAutomation'), dmAutomationController.updateRule);
router.delete('/rules/:id', authenticate, checkProAccess, verifyResourceOwnership('dMAutomation'), dmAutomationController.deleteRule);

module.exports = router;
