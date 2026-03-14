const axios = require('axios');
const logger = require('../utils/logger');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';
const GRAPH_API_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const APP_ID = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI;

class InstagramService {
    /**
     * Exchange OAuth code for a short-lived, then long-lived access token
     */
    async exchangeCodeForToken(code) {
        try {
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

    async refreshToken(oldToken) {
        try {
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

    async getBusinessAccount(accessToken) {
        try {
            const pagesRes = await axios.get(`${GRAPH_API_URL}/me/accounts`, {
                params: { access_token: accessToken }
            });

            const pages = pagesRes.data.data;
            if (!pages || pages.length === 0) throw new Error('No Facebook Pages found');

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
            logger.error('INSTAGRAM_SERVICE', 'Business Account Lookup Error', { error: error.response?.data || error.message });
            throw error;
        }
    }

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

    async getAccountInsights(igUserId, accessToken, period = 'day') {
        const metrics = [
            'impressions', 'reach', 'profile_views', 'follower_count',
            'email_contacts', 'get_directions_clicks', 'text_message_clicks', 'website_clicks'
        ];

        let combinedInsights = {};

        // Fetch each metric individually to prevent one failure from blocking others
        await Promise.all(metrics.map(async (metric) => {
            try {
                const response = await axios.get(`${GRAPH_API_URL}/${igUserId}/insights`, {
                    params: {
                        metric,
                        period,
                        access_token: accessToken
                    }
                });

                if (response.data && response.data.data && response.data.data[0]) {
                    const item = response.data.data[0];
                    if (item.values && item.values.length > 0) {
                        combinedInsights[metric] = item.values[item.values.length - 1].value;
                    }
                }
            } catch (error) {
                // Log granularly so we know exactly which metric for which period is failing
                logger.debug('INSTAGRAM_SERVICE', `Metric [${metric}] failed for period [${period}]`, {
                    error: error.response?.data?.error?.message || error.message
                });
            }
        }));

        return combinedInsights;
    }

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

    // Fetch video_views or plays for a single VIDEO/REEL media item directly
    async getVideoViewCount(mediaId, accessToken) {
        try {
            const response = await axios.get(`${GRAPH_API_URL}/${mediaId}`, {
                params: {
                    fields: 'id,video_views,plays',
                    access_token: accessToken
                }
            });
            // Try video_views first, then plays
            return response.data.video_views || response.data.plays || 0;
        } catch (error) {
            logger.debug('INSTAGRAM_SERVICE', `video_views/plays fetch failed for ${mediaId}`, { error: error.response?.data?.error?.message || error.message });
            return 0;
        }
    }

    async getMediaInsights(mediaId, accessToken, mediaType) {
        const metrics = (mediaType === 'VIDEO' || mediaType === 'REELS')
            ? ['impressions', 'reach', 'engagement', 'video_views', 'plays', 'clips_replays_count', 'saved', 'total_interactions']
            : ['impressions', 'reach', 'engagement', 'saved', 'total_interactions'];

        let combinedInsights = {};

        await Promise.all(metrics.map(async (metric) => {
            try {
                const response = await axios.get(`${GRAPH_API_URL}/${mediaId}/insights`, {
                    params: {
                        metric,
                        access_token: accessToken
                    }
                });

                if (response.data && response.data.data && response.data.data[0]) {
                    combinedInsights[metric] = response.data.data[0].values[0].value;
                }
            } catch (error) {
                logger.debug('INSTAGRAM_SERVICE', `Media metric [${metric}] failed for ${mediaType} ${mediaId}`, {
                    error: error.response?.data?.error?.message || error.message
                });
            }
        }));
        
        // Ensure reach and impressions have defaults if missing
        combinedInsights.reach = combinedInsights.reach || 0;
        combinedInsights.impressions = combinedInsights.impressions || 0;
        
        return combinedInsights;
    }
}

module.exports = new InstagramService();
