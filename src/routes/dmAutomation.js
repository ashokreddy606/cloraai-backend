const express = require('express');
const router = express.Router();
const dmAutomationController = require('../controllers/dmAutomationController');
const { authenticate } = require('../middleware/auth');
const checkProAccess = require('../middleware/checkProAccess');
const verifyResourceOwnership = require('../middleware/ownership');
const validate = require('../middleware/validate');
const { createRuleSchema, updateRuleSchema } = require('../validators/dmAutomation');

// DM Automation — controller handles free tier limit (1 rule) internally
router.post('/rules', authenticate, validate(createRuleSchema), dmAutomationController.createRule);
router.get('/rules', authenticate, dmAutomationController.getRules);

// Protected by ownership check to prevent IDOR + input validation
router.put('/rules/:id', authenticate, validate(updateRuleSchema), verifyResourceOwnership('dMAutomation'), dmAutomationController.updateRule);
router.delete('/rules/:id', authenticate, verifyResourceOwnership('dMAutomation'), dmAutomationController.deleteRule);

module.exports = router;
