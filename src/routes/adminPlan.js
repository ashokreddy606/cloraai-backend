const express = require('express');
const router = express.Router();
const adminPlanController = require('../controllers/adminPlanController');
const { authenticate } = require('../middleware/auth');

// Admin only role check would be ideal here, but using authMiddleware for now
router.post('/plans', authenticate, adminPlanController.createPlan);
router.get('/plans', authenticate, adminPlanController.getPlans);
router.patch('/plans/:id', authenticate, adminPlanController.updatePlan);

router.post('/promos', authenticate, adminPlanController.createPromo);
router.get('/promos', authenticate, adminPlanController.getPromos);

module.exports = router;
