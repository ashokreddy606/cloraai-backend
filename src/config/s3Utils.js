const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { awsConfig } = require('./aws');
const logger = require('../utils/logger');

// Cache S3 clients by region to avoid recreating them
const clientsByRegion = {};

/**
 * Gets an S3 client for a specific region.
 */
const getS3ClientForRegion = (region) => {
    if (!region) region = awsConfig.region;
    
    if (!clientsByRegion[region]) {
        logger.info('AWS:S3', `Creating new S3 client for region: ${region}`);
        clientsByRegion[region] = new S3Client({
            region: region,
            credentials: awsConfig.credentials
        });
    }
    return clientsByRegion[region];
};

/**
 * Generates a signed URL for an S3 object, automatically detecting the region from the URL if possible.
 * 
 * @param {string} s3Url - The raw S3 URL (e.g. https://bucket.s3.region.amazonaws.com/key)
 * @param {number} expiresIn - Expiration in seconds (default 3600)
 * @returns {Promise<string>} - The signed URL or the original URL on failure
 */
const generatePresignedUrl = async (s3Url, expiresIn = 3600) => {
    if (!s3Url || !s3Url.includes('amazonaws.com')) {
        return s3Url;
    }

    try {
        const urlParts = new URL(s3Url);
        // Pathname starts with /, so remove it
        const key = urlParts.pathname.startsWith('/') ? urlParts.pathname.substring(1) : urlParts.pathname;
        
        // Extract bucket and region from hostname
        // Format: [bucket].s3.[region].amazonaws.com OR [bucket].s3.amazonaws.com
        const hostParts = urlParts.hostname.split('.');
        let bucket = hostParts[0];
        let region = awsConfig.region;

        // Find the region part (e.g., s3.us-east-1.amazonaws.com)
        const s3Index = hostParts.indexOf('s3');
        if (s3Index !== -1 && hostParts.length > s3Index + 1) {
            // Check if next part is a region (not amazonaws)
            if (hostParts[s3Index + 1] !== 'amazonaws') {
                region = hostParts[s3Index + 1];
            }
        }

        logger.info('AWS:S3_SIGN', `Detected bucket: ${bucket}, region: ${region}, key: ${key}`);

        const client = getS3ClientForRegion(region);
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        
        const signedUrl = await getSignedUrl(client, command, { expiresIn });
        return signedUrl;
    } catch (err) {
        logger.error('AWS:S3_SIGN_ERROR', `Failed to generate signed URL for ${s3Url}`, { error: err.message });
        return s3Url; // Fallback
    }
};

module.exports = {
    getS3ClientForRegion,
    generatePresignedUrl
};
