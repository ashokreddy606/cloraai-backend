const express = require('express');
const router = express.Router();
const adminPlanController = require('../controllers/adminPlanController');
const authMiddleware = require('../middleware/authMiddleware');

// Admin only role check would be ideal here, but using authMiddleware for now
router.post('/plans', authMiddleware, adminPlanController.createPlan);
router.get('/plans', authMiddleware, adminPlanController.getPlans);
router.patch('/plans/:id', authMiddleware, adminPlanController.updatePlan);

router.post('/promos', authMiddleware, adminPlanController.createPromo);
router.get('/promos', authMiddleware, adminPlanController.getPromos);

module.exports = router;
