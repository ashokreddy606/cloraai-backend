const prisma = require('../lib/prisma');

/**
 * Admin Controller for Managing Plans and Promo Codes
 */

// ─── 1. PLAN CONFIG MANAGEMENT ───────────────────────────────────────────

const createPlan = async (req, res) => {
    try {
        const { planId, name, price, durationDays, active, discountPercent } = req.body;
        const plan = await prisma.planConfig.create({
            data: { planId, name, price, durationDays, active, discountPercent }
        });
        res.json({ success: true, data: plan });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getPlans = async (req, res) => {
    try {
        const plans = await prisma.planConfig.findMany();
        res.json({ success: true, data: plans });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const updatePlan = async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        const plan = await prisma.planConfig.update({
            where: { id },
            data
        });
        res.json({ success: true, data: plan });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// ─── 2. PROMO CODE MANAGEMENT ───────────────────────────────────────────

const createPromo = async (req, res) => {
    try {
        const { code, discountPercent, maxUses, expiryDate } = req.body;
        const promo = await prisma.promoCode.create({
            data: { code, discountPercent, maxUses, expiryDate: new Date(expiryDate) }
        });
        res.json({ success: true, data: promo });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getPromos = async (req, res) => {
    try {
        const promos = await prisma.promoCode.findMany();
        res.json({ success: true, data: promos });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    createPlan,
    getPlans,
    updatePlan,
    createPromo,
    getPromos
};
