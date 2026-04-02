/**
 * validators/dmAutomation.js — Zod schemas for DM Automation routes
 */
const { z } = require('zod');

const triggerTypes = ['keywords', 'any', 'ai'];
const replyTypes = ['text', 'product', 'ai'];

const createRuleSchema = z.object({
    body: z.object({
        keyword: z.string().trim().min(1).max(200).optional().nullable(),
        autoReplyMessage: z.string().trim().min(1).max(2000).optional().nullable(),
        reelId: z.string().trim().max(100).optional().nullable(),
        appendLinks: z.boolean().optional().default(false),
        link1: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        link2: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        link3: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        link4: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        isAI: z.boolean().optional().default(false),
        triggerType: z.enum(triggerTypes).optional().default('keywords'),
        replyType: z.enum(replyTypes).optional().default('text'),
        publicReplies: z.union([z.string(), z.array(z.string())]).optional().nullable(),
        productName: z.string().trim().max(200).optional().nullable(),
        productUrl: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        productDescription: z.string().trim().max(2000).optional().nullable(),
        mustFollow: z.boolean().optional().default(false),
        customFollowEnabled: z.boolean().optional().default(false),
        customFollowHeader: z.string().trim().max(200).optional().nullable(),
        customFollowSubtext: z.string().trim().max(500).optional().nullable(),
        followButtonText: z.string().trim().max(100).optional().nullable(),
        followedButtonText: z.string().trim().max(100).optional().nullable(),
        dmButtonText: z.string().trim().max(100).optional().nullable(),
    }),
});

const updateRuleSchema = z.object({
    params: z.object({
        id: z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid rule ID'),
    }),
    body: createRuleSchema.shape.body.partial().extend({
        isActive: z.boolean().optional(),
    }),
});

module.exports = { createRuleSchema, updateRuleSchema };
