/**
 * logger.js — Production-safe structured logger for CloraAI
 * 
 * - Never logs tokens, secrets, or signatures
 * - Suppresses verbose logs in production
 * - Emits structured JSON for easy parsing
 * - Exposes counters for lightweight operational monitoring
 */

const isProd = process.env.NODE_ENV === 'production';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// In-memory Monitoring Counters
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const counters = {
    dmSent: 0,
    dmFailed: 0,
    dmSkippedLimit: 0,
    dmSkippedIdempotent: 0,
    tokenRefreshSuccess: 0,
    tokenRefreshFailed: 0,
    webhookProcessingErrors: 0,
    meta429Errors: 0,
    schedulerPublished: 0,
    schedulerFailed: 0,
    schedulerOrphansRecovered: 0
};

const increment = (key) => {
    if (counters[key] !== undefined) counters[key]++;
};

const getCounters = () => ({ ...counters });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Scrub any value that looks like a secret before logging
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const SENSITIVE_KEYS = ['accessToken', 'access_token', 'token', 'secret', 'password', 'signature', 'razorpay_signature', 'jwt'];

const scrub = (obj) => {
    if (typeof obj !== 'object' || obj === null) return obj;
    const clean = {};
    for (const [key, val] of Object.entries(obj)) {
        const lk = key.toLowerCase();
        if (SENSITIVE_KEYS.some(k => lk.includes(k))) {
            clean[key] = '[REDACTED]';
        } else if (typeof val === 'object') {
            clean[key] = scrub(val);
        } else {
            clean[key] = val;
        }
    }
    return clean;
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Core log functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const log = (level, context, message, meta = {}) => {
    if (isProd && level === 'debug') return; // Suppress debug in prod

    const entry = {
        ts: new Date().toISOString(),
        level,
        context,
        message,
        ...(Object.keys(meta).length > 0 ? { meta: scrub(meta) } : {})
    };
    const output = JSON.stringify(entry);

    if (level === 'error' || level === 'warn') {
        process.stderr.write(output + '\n');
    } else {
        process.stdout.write(output + '\n');
    }
};

module.exports = {
    debug: (ctx, msg, meta) => log('debug', ctx, msg, meta),
    info: (ctx, msg, meta) => log('info', ctx, msg, meta),
    warn: (ctx, msg, meta) => log('warn', ctx, msg, meta),
    error: (ctx, msg, meta) => log('error', ctx, msg, meta),
    increment,
    getCounters
};
