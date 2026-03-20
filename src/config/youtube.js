const { google } = require('googleapis');
const logger = require('../utils/logger');

/**
 * Creates a centralized YouTube OAuth2 client instance.
 * Ensures the redirect_uri is strictly loaded from environment variables 
 * to prevent mismatch errors in production.
 */
const getYoutubeOAuth2Client = () => {
    const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI;

    if (!redirectUri) {
        logger.error('YOUTUBE_CONFIG', 'CRITICAL: YOUTUBE_REDIRECT_URI is not defined in environment variables.');
    }

    // Always log the redirect URI being used (essential for debugging mismatch errors)
    logger.info('YOUTUBE_CONFIG', `Initializing OAuth2Client with redirect_uri: ${redirectUri || 'UNDEFINED'}`);

    return new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri
    );
};

module.exports = { getYoutubeOAuth2Client };
