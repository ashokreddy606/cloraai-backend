/**
 * validators/youtube.js — Zod schemas for YouTube automation routes
 */
const { z } = require('zod');

const createRuleSchema = z.object({
    body: z.object({
        keyword: z.string().trim().min(1).max(200),
        replyMessage: z.string().trim().min(1).max(2000),
        isActive: z.boolean().optional().default(true),
        replyDelay: z.coerce.number().int().min(0).max(3600).optional().default(0),
        limitPerHour: z.coerce.number().int().min(1).max(100).optional().default(20),
        videoId: z.string().trim().max(50).optional().nullable(),
        subscriberOnly: z.boolean().optional().default(false),
        onlySubscribers: z.boolean().optional().default(false),
        appendLinks: z.boolean().optional().default(false),
        link1: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        link2: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        link3: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        link4: z.string().url().max(2048).optional().nullable().or(z.literal('')),
        isAI: z.boolean().optional().default(false),
        triggerType: z.string().trim().optional().default('keywords'),
    }),
});

const updateRuleSchema = z.object({
    params: z.object({
        id: z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid rule ID'),
    }),
    body: createRuleSchema.shape.body.partial(),
});

const submitLeadSchema = z.object({
    body: z.object({
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().email().max(320),
        phone: z.string().trim().max(20).optional().nullable(),
    }),
});

module.exports = { createRuleSchema, updateRuleSchema, submitLeadSchema };
