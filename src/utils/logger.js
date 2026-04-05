/**
 * logger.js — Production-safe structured logger for CloraAI using winston
 * 
 * - Never logs tokens, secrets, or signatures
 * - Suppresses verbose logs in production
 * - Emits structured JSON for easy parsing
 * - Exposes counters for lightweight operational monitoring
 */

const winston = require('winston');
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
const SENSITIVE_KEYS = [
    'accesstoken', 'access_token', 'token', 'secret', 'password', 
    'signature', 'razorpay_signature', 'jwt', 'authorization', 
    'cookie', 'set-cookie', 'apikey', 'api_key', 'client_secret', 
    'refresh_token', 'otp', 'passcode', 'cvv', 'cardnumber'
];

const scrub = (obj) => {
    if (obj === null || obj === undefined) return obj;
    
    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => scrub(item));
    }

    // Handle non-objects
    if (typeof obj !== 'object') return obj;

    // Handle objects
    const clean = {};
    for (const [key, val] of Object.entries(obj)) {
        const lk = key.toLowerCase();
        
        // Check if key is sensitive
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
// Winston Logger Setup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const winstonLogger = winston.createLogger({
    level: isProd ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS Z' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// Wrapper to maintain backward compatibility with old API
const log = (level, context, message, meta = {}) => {
    // ── Diagnostic Visibility ──
    // If an error is passed in meta, append its message to the primary log message
    // so it's visible in plain-text log viewers (like Railway) that might hide JSON metadata.
    let finalMessage = message;
    if (meta && meta.error) {
        finalMessage = `${message} — DETAILS: ${meta.error}`;
    }

    const scrubbedMeta = Object.keys(meta).length > 0 ? scrub(meta) : undefined;

    winstonLogger.log({
        level,
        context,
        message: finalMessage,
        ...scrubbedMeta
    });
};

module.exports = {
    debug: (ctx, msg, meta) => log('debug', ctx, msg, meta),
    info: (ctx, msg, meta) => log('info', ctx, msg, meta),
    warn: (ctx, msg, meta) => log('warn', ctx, msg, meta),
    error: (ctx, msg, meta) => log('error', ctx, msg, meta),
    increment,
    getCounters,
    winstonLogger // export internal instance if needed
};
