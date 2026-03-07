const logger = require('./logger');

const CRITICAL_ENV_VARS = [
    'DATABASE_URL',
    'JWT_SECRET',
    'REDIS_URL'
];

const OPTIONAL_FEATURE_VARS = [
    'OPENAI_API_KEY',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'S3_BUCKET_NAME',
    'INSTAGRAM_APP_SECRET',
    'ADMIN_SECRET_KEY',
    'GOOGLE_CLIENT_ID',
    'TOKEN_ENCRYPTION_SECRET'
];

/**
 * Validate that all required environment variables are set.
 * Throws an error if CRITICAL variables are missing in production.
 * Logs warnings for missing OPTIONAL variables.
 */
const validateEnv = () => {
    const missingCritical = CRITICAL_ENV_VARS.filter(key => !process.env[key]);
    const missingOptional = OPTIONAL_FEATURE_VARS.filter(key => !process.env[key]);

    if (missingCritical.length > 0) {
        const msg = `CRITICAL: Missing required environment variables: ${missingCritical.join(', ')}`;
        logger.error('ENV_VALIDATOR', msg);
        if (process.env.NODE_ENV === 'production') {
            throw new Error(msg);
        }
    }

    if (missingOptional.length > 0) {
        logger.warn('ENV_VALIDATOR', `Missing optional feature variables: ${missingOptional.join(', ')}. Some features will be disabled.`);
    }

    // Specific validation for JWT_SECRET
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length < 32) {
        logger.warn('ENV_VALIDATOR', 'JWT_SECRET is too short (less than 32 chars). Brute-force risk high.');
    }
};

module.exports = validateEnv;
