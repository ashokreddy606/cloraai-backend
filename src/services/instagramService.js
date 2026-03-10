const axios = require('axios');
const logger = require('../utils/logger');

const GRAPH_API_URL = 'https://graph.facebook.com/v19.0';
const APP_ID = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;

class InstagramService {
    /**
     * Exchange OAuth code for a short-lived, then long-lived access token
     * @param {string} code 
     */
    async exchangeCodeForToken(code) {
        try {
            // 1. Short-lived token
            const shortLivedRes = await axios.get(`${GRAPH_API_URL}/oauth/access_token`, {
                params: {
                    client_id: APP_ID,
                    client_secret: APP_SECRET,
                    grant_type: 'authorization_code',
                    redirect_uri: REDIRECT_URI,
                    code: code
                }
            });

            const shortLivedToken = shortLivedRes.data.access_token;

            // 2. Exchange for long-lived token (60 days)
            const longLivedRes = await axios.get(`${GRAPH_API_URL}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: APP_ID,
                    client_secret: APP_SECRET,
                    fb_exchange_token: shortLivedToken
                }
            });

            return {
                accessToken: longLivedRes.data.access_token,
                expiresIn: longLivedRes.data.expires_in,
                tokenType: longLivedRes.data.token_type
            };
        } catch (error) {
            logger.error('INSTAGRAM_SERVICE', 'OAuth Token Exchange Error', { error: error.response?.data || error.message });
            throw error;
        }
    }

    /**
     * Refresh a long-lived token
     * @param {string} oldToken 
     */
    async refreshToken(oldToken) {
        try {
            // Meta recommends refreshing page access tokens through fb_exchange_token for long-lived user tokens
            const response = await axios.get(`${GRAPH_API_URL}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: APP_ID,
                    client_secret: APP_SECRET,
                    fb_exchange_token: oldToken
                }
            });
            return {
                accessToken: response.data.access_token,
                expiresIn: response.data.expires_in
            };
        } catch (error) {
            logger.error('INSTAGRAM_SERVICE', 'Token Refresh Error', { error: error.response?.data || error.message });
            throw error;
        }
    }

    /**
     * Find the Instagram Business Account linked to the user's FB Pages
     * @param {string} accessToken 
     */
    async getBusinessAccount(accessToken) {
        try {
            // 1. Get user's pages
            const pagesRes = await axios.get(`${GRAPH_API_URL}/me/accounts`, {
                params: { access_token: accessToken }
            });

            const pages = pagesRes.data.data;
            if (!pages || pages.length === 0) throw new Error('No Facebook Pages found');

            // 2. Find page with linked IG Business Account
            for (const page of pages) {
                const igRes = await axios.get(`${GRAPH_API_URL}/${page.id}`, {
                    params: {
                        fields: 'instagram_business_account',
                        access_token: accessToken
                    }
                });

                if (igRes.data.instagram_business_account) {
                    return {
                        instagramBusinessAccountId: igRes.data.instagram_business_account.id,
                        facebookPageId: page.id,
                        pageAccessToken: page.access_token
                    };
                }
            }

            throw new Error('No Instagram Business Account linked to your Facebook Pages');
        } catch (error) {
            console.error(error.response?.data);
            logger.error('INSTAGRAM_SERVICE', 'Business Account Lookup Error', { error: error.response?.data || error.message });
            throw error;
        }
    }

    /**
     * Get basic account stats (followers, media count)
     * @param {string} igUserId - Instagram Business Account ID
     * @param {string} accessToken - User's access token
     */
    async getAccountStats(igUserId, accessToken) {
        try {
            const response = await axios.get(`${GRAPH_API_URL}/${igUserId}`, {
                params: {
                    fields: 'followers_count,follows_count,media_count,name,username,profile_picture_url,biography,website',
                    access_token: accessToken
                }
            });
            return response.data;
        } catch (error) {
            logger.error('INSTAGRAM_SERVICE', 'Error fetching account stats', { error: error.response?.data || error.message });
            throw error;
        }
    }

    /**
     * Get Instagram Profile Data
     */
    async getInstagramProfileData(igUserId, accessToken) {
        try {
            const response = await axios.get(`${GRAPH_API_URL}/${igUserId}`, {
                params: {
                    fields: 'id,username,followers_count,media_count',
                    access_token: accessToken
                }
            });
            return response.data;
        } catch (error) {
            logger.error('INSTAGRAM_SERVICE', 'Error fetching profile data', { error: error.response?.data || error.message });
            throw error;
        }
    }

    /**
     * Get user's media items
     * @param {string} igUserId 
     * @param {string} accessToken 
     */
    async getUserMedia(igUserId, accessToken) {
        try {
            const response = await axios.get(`${GRAPH_API_URL}/${igUserId}/media`, {
                params: {
                    fields: 'id,caption,like_count,comments_count,timestamp,media_type,media_url',
                    access_token: accessToken
                }
            });
            return response.data.data;
        } catch (error) {
            logger.error('INSTAGRAM_SERVICE', 'Error fetching user media', { error: error.response?.data || error.message });
            throw error;
        }
    }

    /**
     * Get insights for a specific media item (Post/Reel)
     * @param {string} mediaId 
     * @param {string} accessToken 
     * @param {string} mediaType - IMAGE, VIDEO, or CAROUSEL_ALBUM
     */
    async getMediaInsights(mediaId, accessToken, mediaType) {
        try {
            const metrics = (mediaType === 'VIDEO') ? 'reach,impressions,saved,video_views' : 'reach,impressions,saved';

            const response = await axios.get(`${GRAPH_API_URL}/${mediaId}/insights`, {
                params: {
                    metric: metrics,
                    access_token: accessToken
                }
            });

            const insights = {};
            if (response.data && response.data.data) {
                response.data.data.forEach(item => {
                    if (item.values && item.values.length > 0) {
                        insights[item.name] = item.values[0].value;
                    }
                });
            }

            return insights;
        } catch (error) {
            logger.warn('INSTAGRAM_SERVICE', `Could not fetch insights for media ${mediaId}`, { error: error.response?.data || error.message });
            return { reach: 0, impressions: 0 };
        }
    }
}

module.exports = new InstagramService();
