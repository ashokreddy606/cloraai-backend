const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const logger = require('../utils/logger');
const axios = require('axios');

// Process comments from the queue
const commentWorker = new Worker(QUEUES.COMMENT, async (job) => {
    const { mediaId, commentId, commentText, instagramId, senderId, instagramAccessToken, userId } = job.data;
    logger.info('WORKER', `Processing comment for media ${mediaId}`);
    try {
        if (!userId || !senderId || !commentText) return { skipped: true, reason: 'Missing data' };

        const prisma = require('../lib/prisma');
        
        // Find existing rules for this user
        const rules = await prisma.dMAutomation.findMany({
            where: { userId, isActive: true }
        });

        const sortedRules = rules.sort((a, b) => b.keyword.length - a.keyword.length);
        const incomingText = commentText.trim().toLowerCase().replace(/\s+/g, ' ');

        const matchesKeyword = (text, keyword) => {
            try {
                const keywords = keyword.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
                return keywords.some(kw => {
                    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
                    return regex.test(text);
                });
            } catch { return false; }
        };

        let matchedRule = null;
        for (const rule of sortedRules) {
            const isMatchReel = !rule.reelId || rule.reelId === mediaId;
            if (isMatchReel && matchesKeyword(incomingText, rule.keyword)) {
                matchedRule = rule;
                break;
            }
        }

        if (matchedRule) {
            let finalMessage = matchedRule.autoReplyMessage;
            if (matchedRule.appendLinks) {
                const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
                if (links.length > 0) {
                    finalMessage += '\n\n' + links.join('\n');
                }
            }

            const messageId = `comment_${commentId}`;
            const existing = await prisma.dmInteraction.findUnique({ where: { messageId } });
            
            if (!existing) {
                await prisma.dmInteraction.create({
                    data: { userId, messageId, ruleId: matchedRule.id, status: 'sent' }
                });
                
                const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${instagramAccessToken}`;
                await axios.post(url, {
                    recipient: { comment_id: commentId },
                    message: { text: finalMessage }
                });
                logger.info('WORKER', `Sent DM reply for comment on reel ${mediaId}`);
            }
        }

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
