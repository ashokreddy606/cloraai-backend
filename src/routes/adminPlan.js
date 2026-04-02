const express = require('express');
const router = express.Router();
const adminPlanController = require('../controllers/adminPlanController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// SECURITY: All routes require auth + admin role (previously missing requireAdmin)
router.use(authenticate, requireAdmin);

router.post('/plans', adminPlanController.createPlan);
router.get('/plans', adminPlanController.getPlans);
router.patch('/plans/:id', adminPlanController.updatePlan);

router.post('/promos', adminPlanController.createPromo);
router.get('/promos', adminPlanController.getPromos);

module.exports = router;
