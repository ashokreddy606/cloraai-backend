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
        const metricSets = ['impressions,reach', 'reach', 'engagement'];
        
        for (const metrics of metricSets) {
            try {
                const response = await axios.get(`${GRAPH_API_URL}/${igUserId}/insights`, {
                    params: {
                        metric: metrics,
                        period: period,
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
                
                if (Object.keys(insights).length > 0) return insights;
            } catch (error) {
                const errorMsg = error.response?.data?.error?.message || error.message;
                logger.debug('INSTAGRAM_SERVICE', `Account metrics [${metrics}] failed for ${igUserId}: ${errorMsg}`);
            }
        }
        return { impressions: 0, reach: 0 };
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

    async getMediaInsights(mediaId, accessToken, mediaType) {
        const metricSets = (mediaType === 'VIDEO')
            ? ['reach,saved,plays', 'reach,plays', 'reach,video_views', 'reach,impressions', 'reach,engagement', 'reach']
            : ['reach,impressions,saved', 'reach,impressions', 'reach,engagement', 'reach'];

        for (const metrics of metricSets) {
            try {
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

                if (insights.plays !== undefined) insights.impressions = insights.plays;
                else if (insights.video_views !== undefined) insights.impressions = insights.video_views;

                if (insights.reach === undefined) insights.reach = 0;
                if (insights.impressions === undefined) insights.impressions = 0;

                return insights;
            } catch (error) {
                const errorData = error.response?.data?.error?.message || error.message;
                if (metrics === metricSets[metricSets.length - 1]) {
                    logger.warn('INSTAGRAM_SERVICE', `All insight fallbacks failed for ${mediaId}`, {
                        mediaType,
                        error: errorData
                    });
                } else {
                    logger.debug('INSTAGRAM_SERVICE', `Metric set [${metrics}] failed for ${mediaId}, trying next...`);
                }
            }
        }
        return { reach: 0, impressions: 0 };
    }
}

module.exports = new InstagramService();
