/**
 * validators/subscription.js — Zod schemas for subscription routes
 */
const { z } = require('zod');

const VALID_PRODUCT_IDS = [
    'cloraai_pro_monthly',
    'cloraai_pro_yearly',
    'cloraai_100_credits',
    'cloraai_500_credits',
];

const verifyGooglePlaySchema = z.object({
    body: z.object({
        purchaseToken: z.string().trim().min(10).max(2000),
        productId: z.enum(VALID_PRODUCT_IDS, {
            errorMap: () => ({ message: `productId must be one of: ${VALID_PRODUCT_IDS.join(', ')}` }),
        }),
        packageName: z.string().trim().max(200).optional().default('com.cloraai.app'),
    }),
});

module.exports = { verifyGooglePlaySchema };
