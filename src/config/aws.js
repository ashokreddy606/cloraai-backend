const { S3Client } = require('@aws-sdk/client-s3');

/**
 * AWS S3 Configuration
 * 
 * PRODUCTION SECURITY: 
 * All credentials MUST be loaded from environment variables (process.env).
 * NEVER load secrets from files (fs.readFileSync) to ensure compatibility with Railway and other cloud providers.
 */

const awsConfig = {
    region: (process.env.AWS_REGION || 'us-east-1').trim(),
    credentials: {
        accessKeyId: (process.env.AWS_ACCESS_KEY_ID || '').trim(),
        secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
    },
    bucketName: (process.env.AWS_S3_BUCKET_NAME || 'cloraai-assets').trim()
};

// Validate credentials in non-test environments
if (process.env.NODE_ENV !== 'test') {
    if (!awsConfig.credentials.accessKeyId || !awsConfig.credentials.secretAccessKey) {
        console.warn('[AWS] WARNING: AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is missing. S3 features will fail.');
    }
}

const s3Client = new S3Client({
    region: awsConfig.region,
    credentials: awsConfig.credentials
});

module.exports = {
    s3Client,
    awsConfig
};
