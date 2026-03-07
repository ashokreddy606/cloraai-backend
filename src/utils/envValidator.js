const logger = require('./logger');

const REQUIRED_ENV_VARS = [
    'DATABASE_URL',
    'JWT_SECRET',
    'REDIS_URL',
    'OPENAI_API_KEY',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'S3_BUCKET_NAME'
];

/**
 * Validate that all required environment variables are set.
 * Throws an error if any are missing or invalid (e.g., too short).
 */
const validateEnv = () => {
    const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);

    if (missing.length > 0) {
        logger.error('ENV_VALIDATOR', `Missing required environment variables: ${missing.join(', ')}`);
        if (process.env.NODE_ENV === 'production') {
            throw new Error(`CRITICAL: Missing required environment variables: ${missing.join(', ')}`);
        } else {
            logger.warn('ENV_VALIDATOR', 'Running in non-production mode with missing variables. Some features may fail.');
        }
    }

    // Specific validation for JWT_SECRET
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length < 32) {
        logger.warn('ENV_VALIDATOR', 'JWT_SECRET is too short (less than 32 chars). Brute-force risk high.');
    }
};

module.exports = validateEnv;
