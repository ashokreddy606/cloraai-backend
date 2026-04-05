const logger = require('./logger');

const CRITICAL_ENV_VARS = [
    'DATABASE_URL',
    'JWT_SECRET',
    'INSTAGRAM_APP_SECRET',
    'META_WEBHOOK_VERIFY_TOKEN',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
];

const OPTIONAL_FEATURE_VARS = [
    'OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AWS_S3_BUCKET_NAME',
    'ADMIN_SECRET_KEY',
    'GOOGLE_CLIENT_ID',
    'FACEBOOK_APP_ID',
    'FACEBOOK_APP_SECRET',
    'TOKEN_ENCRYPTION_SECRET',
    'REDIS_URL'
];

/**
 * Validate that all required environment variables are set.
 * Throws an error if CRITICAL variables are missing in production.
 * Logs warnings for missing OPTIONAL variables.
 */
const validateEnv = () => {
    const isProduction = process.env.NODE_ENV === 'production';

    // ── Block CHANGE_ME placeholders ─────────────────────────────────────
    const allVars = [...CRITICAL_ENV_VARS, ...OPTIONAL_FEATURE_VARS];
    for (const key of allVars) {
        const val = process.env[key];
        if (val && (val.startsWith('CHANGE_ME') || val === '')) {
            const msg = `${key} still has placeholder value or is empty. Set a real value before running.`;
            if (isProduction) {
                logger.error('ENV_VALIDATOR', `CRITICAL: ${msg}`);
                throw new Error(msg);
            } else {
                logger.warn('ENV_VALIDATOR', `DEVELOPMENT WARNING: ${msg}`);
            }
        }
    }

    const missingCritical = CRITICAL_ENV_VARS.filter(key => !process.env[key]);
    const missingOptional = OPTIONAL_FEATURE_VARS.filter(key => !process.env[key]);

    if (missingCritical.length > 0) {
        const msg = `CRITICAL: Missing required environment variables: ${missingCritical.join(', ')}`;
        logger.error('ENV_VALIDATOR', msg);
        if (isProduction) {
            throw new Error(msg);
        }
    }

    if (missingOptional.length > 0) {
        logger.warn('ENV_VALIDATOR', `Missing optional feature variables: ${missingOptional.join(', ')}. Some features will be disabled.`);
        if (missingOptional.includes('REDIS_URL')) {
            if (isProduction) {
                logger.error('ENV_VALIDATOR', 'CRITICAL: REDIS_URL is required in production for rate limiting and sessions.');
            } else {
                logger.info('ENV_VALIDATOR', 'TIP: REDIS_URL is missing. BullMQ and Caching will use localhost:6379.');
            }
        }
        if (missingOptional.includes('TOKEN_ENCRYPTION_SECRET')) {
            logger.warn('ENV_VALIDATOR', 'CRITICAL TIP: TOKEN_ENCRYPTION_SECRET is missing. OAuth tokens are at risk!');
        }
    }

    // ── JWT_SECRET strength ──────────────────────────────────────────────
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret) {
        if (isProduction && jwtSecret.length < 64) {
            logger.error('ENV_VALIDATOR', 'CRITICAL: JWT_SECRET must be at least 64 characters in production.');
            throw new Error('JWT_SECRET must be at least 64 characters in production.');
        } else if (jwtSecret.length < 32) {
            logger.warn('ENV_VALIDATOR', 'JWT_SECRET is too short (less than 32 chars). Brute-force risk high.');
        }
    }

    // ── Reject NODE_ENV=development in Railway ──────────────────────────
    if (process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV === 'development') {
        logger.error('ENV_VALIDATOR', 'CRITICAL: NODE_ENV is set to "development" on Railway. This disables security middleware. Fix immediately.');
        throw new Error('NODE_ENV must not be "development" in Railway deployment.');
    }
};

module.exports = validateEnv;
