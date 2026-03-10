const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const logger = require('../utils/logger');
const axios = require('axios');

// Process comments from the queue
const commentWorker = new Worker(QUEUES.COMMENT, async (job) => {
    const { mediaId, commentText, instagramAccessToken } = job.data;
    logger.info('WORKER', `Processing comment for media ${mediaId}`);
    try {
        // Here you would implement logic to read/store comments
        return { success: true };
    } catch (error) {
        logger.error('WORKER', `Comment processing failed:`, { error: error.message });
        throw error;
    }
}, { connection, concurrency: 5 });

// Process replies from the queue
const replyWorker = new Worker(QUEUES.REPLY, async (job) => {
    const { commentId, replyText, instagramAccessToken } = job.data;
    logger.info('WORKER', `Sending reply for comment ${commentId}`);
    try {
        const response = await axios.post(`https://graph.facebook.com/v19.0/${commentId}/replies`, {
            message: replyText
        }, {
            params: { access_token: instagramAccessToken }
        });
        return { success: true, id: response.data.id };
    } catch (error) {
        logger.error('WORKER', `Reply sending failed:`, { error: error.response?.data || error.message });
        throw error;
    }
}, { connection, concurrency: 5 });

logger.info('WORKER', '✅ Instagram Automation Workers initialized');

module.exports = { commentWorker, replyWorker };
