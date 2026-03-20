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
        // Define supported periods for each metric based on Instagram Graph API v18.0+
        const metricSupport = {
            'reach': ['day', 'days_28'],
            'impressions': ['day'],
            'profile_views': ['day'],
            'accounts_engaged': ['day'],
            'follower_count': ['day']
        };

        const allMetrics = ['reach', 'impressions', 'profile_views', 'accounts_engaged', 'follower_count'];
        
        // Filter metrics that support the requested period
        const supportedMetrics = allMetrics.filter(m => metricSupport[m]?.includes(period));
        
        let combinedInsights = {};

        await Promise.all(supportedMetrics.map(async (metric) => {
            try {
                let params = {
                    metric,
                    period,
                    access_token: accessToken
                };

                // Specific parameter required for several metrics
                if (['profile_views', 'accounts_engaged'].includes(metric)) {
                    params.metric_type = 'total_value';
                }

                const response = await axios.get(`${GRAPH_API_URL}/${igUserId}/insights`, { params });

                if (response.data?.data?.[0]?.values) {
                    const values = response.data.data[0].values;
                    const value = values[values.length - 1].value;
                    combinedInsights[metric] = value;
                    logger.info('INSTAGRAM_SERVICE', `Account Insight: ${metric} (${period}) = ${value}`);
                }
            } catch (error) {
                const errorMsg = error.response?.data?.error?.message || error.message;
                // Log granularly to identify which metrics are actually supported
                if (!errorMsg.includes('must be one of') && !errorMsg.includes('incompatible with the metric')) {
                    console.log(`[INSTAGRAM_SERVICE] Account Insight Failed: ${metric} (${period}) - ${errorMsg}`);
                }
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

    // Fetch plays or play_count for a single VIDEO/REEL media item directly
    async getVideoViewCount(mediaId, accessToken) {
        try {
            const response = await axios.get(`${GRAPH_API_URL}/${mediaId}`, {
                params: {
                    fields: 'id,plays,play_count',
                    access_token: accessToken
                }
            });
            const data = response.data;
            const views = data.play_count || data.plays || 0;
            if (views > 0) console.log(`[INSTAGRAM SUCCESS] Direct Play Count for ${mediaId}: ${views}`);
            return views;
        } catch (error) {
            const errorMsg = error.response?.data?.error?.message || error.message;
            console.log(`[INSTAGRAM FAILED] Direct Play Count Failed for ${mediaId}: ${errorMsg}`);
            return 0;
        }
    }

    async getMediaInsights(mediaId, accessToken, mediaType) {
        const metrics = (mediaType === 'VIDEO' || mediaType === 'REELS')
            ? ['plays', 'reach', 'impressions', 'total_interactions']
            : ['impressions', 'reach', 'total_interactions'];

        let combinedInsights = {};

        await Promise.all(metrics.map(async (metric) => {
            try {
                const response = await axios.get(`${GRAPH_API_URL}/${mediaId}/insights`, {
                    params: {
                        metric,
                        access_token: accessToken
                    }
                });

                if (response.data?.data?.[0]) {
                    const value = response.data.data[0].values[0].value;
                    combinedInsights[metric] = value;
                    if (value > 0) {
                        console.log(`[INSTAGRAM SUCCESS] Media Insight: ${mediaId} ${metric} = ${value}`);
                    }
                }
            } catch (error) {
                const errorMsg = error.response?.data?.error?.message || error.message;
                console.log(`[INSTAGRAM FAILED] Media Insight: ${mediaId} ${metric} - ${errorMsg}`);
            }
        }));
        
        // Ensure defaults
        combinedInsights.reach = combinedInsights.reach || 0;
        combinedInsights.impressions = combinedInsights.impressions || 0;
        
        return combinedInsights;
    }

    /**
     * Subscribe a Facebook Page (linked to IG) to the app's webhooks.
     * Required to receive 'feed' (comments) and 'messages' events.
     */
    async subscribePage(pageId, pageAccessToken) {
        try {
            const url = `${GRAPH_API_URL}/${pageId}/subscribed_apps`;
            const response = await axios.post(url, {
                subscribed_fields: 'feed,messages,mention,comments'
            }, {
                params: { access_token: pageAccessToken }
            });
            logger.info('INSTAGRAM_SERVICE:SUBSCRIBE', `Successfully subscribed page ${pageId}`, { data: response.data });
            return response.data;
        } catch (error) {
            const errData = error.response?.data || error.message;
            logger.error('INSTAGRAM_SERVICE:SUBSCRIBE_ERROR', `Failed to subscribe page ${pageId}: ${typeof errData === 'object' ? JSON.stringify(errData) : errData}`);
            // Do not throw, as this is a background enhancement
            return null;
        }
    }
}

module.exports = new InstagramService();
