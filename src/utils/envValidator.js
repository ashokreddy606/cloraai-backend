const logger = require('./logger');

const CRITICAL_ENV_VARS = [
    'DATABASE_URL',
    'JWT_SECRET'
];

const OPTIONAL_FEATURE_VARS = [
    'OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AWS_S3_BUCKET_NAME',
    'INSTAGRAM_APP_SECRET',
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
        if (missingOptional.includes('REDIS_URL')) {
            logger.info('ENV_VALIDATOR', 'TIP: REDIS_URL is missing. BullMQ and Caching will use localhost:6379.');
        }
        if (missingOptional.includes('TOKEN_ENCRYPTION_SECRET')) {
            logger.warn('ENV_VALIDATOR', 'CRITICAL TIP: TOKEN_ENCRYPTION_SECRET is missing. OAuth tokens are at risk!');
        }
    }

    // Specific validation for JWT_SECRET
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length < 32) {
        logger.warn('ENV_VALIDATOR', 'JWT_SECRET is too short (less than 32 chars). Brute-force risk high.');
    }
};

module.exports = validateEnv;
