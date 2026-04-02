/**
 * validators/common.js — Shared validation schemas
 */
const { z } = require('zod');

// MongoDB ObjectID: exactly 24 hex characters
const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid ID format');

// Pagination query params
const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Sanitize string: trim + collapse whitespace
const sanitizedString = (minLen = 1, maxLen = 1000) =>
    z.string().trim().min(minLen).max(maxLen);

// URL validation (optional)
const optionalUrl = z.string().url().max(2048).optional().nullable().or(z.literal(''));

module.exports = {
    objectIdSchema,
    paginationSchema,
    sanitizedString,
    optionalUrl,
};
