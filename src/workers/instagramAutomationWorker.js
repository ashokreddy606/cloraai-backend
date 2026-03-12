const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const logger = require('../utils/logger');
const axios = require('axios');
const prisma = require('../lib/prisma');
const { appConfig } = require('../config');
const { matchesKeyword } = require('../utils/automationUtils');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

/**
 * HELPER: Simple sleep
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * HELPER: Handle Meta API Errors (Rate Limits & Token Expiry)
 */
const handleMetaError = async (error, userId, instagramId) => {
    const statusCode = error.response?.status;
    const errorCode = error.response?.data?.error?.code;

    // Error 190: Token expired or invalid
    if (errorCode === 190) {
        logger.warn('WORKER:TOKEN_EXPIRED', `Token expired for account ${instagramId}`, { userId });
        await prisma.instagramAccount.updateMany({
            where: { instagramId, userId },
            data: { isConnected: false }
        }).catch(() => {});
    }

    // 429 or 613: Rate limits
    if (statusCode === 429 || errorCode === 613) {
        logger.error('WORKER:RATE_LIMIT', `Meta rate limit hit for account ${instagramId}`);
        // BullMQ will retry based on exponential backoff defined in queue.js
    }

    return { statusCode, errorCode };
};

/**
 * WORKER: Process Comments & DMs
 */
const commentWorker = new Worker(QUEUES.COMMENT, async (job) => {
    const { mediaId, commentId, commentText, messageId: dmMessageId, text: dmText, instagramId, senderId, instagramAccessToken, userId } = job.data;
    
    // Standardize identification
    const isDM = !!dmMessageId;
    const eventId = isDM ? dmMessageId : `comment_${commentId}`;
    const incomingText = isDM ? dmText : commentText;

    logger.info('WORKER:START', `Processing ${isDM ? 'DM' : 'comment'} ${eventId}`);

    try {
        if (!userId || !senderId || !incomingText) {
            return { skipped: true, reason: 'Missing payload data' };
        }

        // 1. Idempotency Check
        const existing = await prisma.dmInteraction.findUnique({ where: { messageId: eventId } });
        if (existing) {
            logger.debug('WORKER:IDEMPOTENCY', `Event ${eventId} already processed. Skipping.`);
            return { skipped: true, reason: 'Duplicate event' };
        }

        // 2. Resolve Automation Rules
        // For comments, we check reelId. For DMs, reelId is null.
        const rules = await prisma.dMAutomation.findMany({
            where: { userId, isActive: true, OR: [{ reelId: null }, { reelId: mediaId }] }
        });

        // Rules prioritized by keyword length (most specific first)
        const sortedRules = rules.sort((a, b) => b.keyword.length - a.keyword.length);

        let matchedRule = null;
        for (const rule of sortedRules) {
            if (matchesKeyword(incomingText, rule.keyword)) {
                matchedRule = rule;
                break;
            }
        }

        if (!matchedRule) {
            logger.debug('WORKER:SKIPPED', `No matching rule for ${isDM ? 'DM' : 'comment'} ${eventId}`);
            return { success: true, matched: false };
        }

        // 3. Atomically claim this event
        try {
            await prisma.dmInteraction.create({
                data: { userId, messageId: eventId, ruleId: matchedRule.id, status: 'sent' }
            });
        } catch (err) {
            return { skipped: true, reason: 'Event claimed by another worker' };
        }

        // 4. Prepare Reply
        let finalMessage = matchedRule.autoReplyMessage;
        if (matchedRule.appendLinks) {
            const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
            if (links.length > 0) finalMessage += '\n\n' + links.join('\n');
        }

        // 5. Execute API Calls (Private Reply then Public Reply for comments)
        // Link: https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
        const dmUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${instagramAccessToken}`;
        const dmRecipient = isDM ? { id: senderId } : { comment_id: commentId };

        try {
            await axios.post(dmUrl, {
                recipient: dmRecipient,
                message: { text: finalMessage }
            });
            logger.info('WORKER:DM_SENT', `Direct message sent for ${eventId}`);
        } catch (err) {
            await handleMetaError(err, userId, instagramId);
            logger.error('WORKER:ERROR', `DM failed for ${eventId}`, { error: err.response?.data || err.message });
            throw err; // Retry
        }

        // For comments, also send a public reply
        if (!isDM) {
            await sleep(150); // Safety delay between API calls

            const replyUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${commentId}/replies`;
            try {
                await axios.post(replyUrl, { message: finalMessage }, { params: { access_token: instagramAccessToken } });
                logger.info('WORKER:REPLY_SENT', `Public comment reply sent for ${eventId}`);
            } catch (err) {
                await handleMetaError(err, userId, instagramId);
                logger.error('WORKER:ERROR', `Public reply failed for ${commentId}`, { error: err.response?.data || err.message });
                // We don't necessarily want to fail the whole job if the DM worked but the public reply failed (less critical)
            }
        }

        logger.info('WORKER:SUCCESS', `Automation completed for ${eventId}`);
        return { success: true };

    } catch (error) {
        logger.error('WORKER:ERROR', `Job failed for ${eventId}:`, { error: error.message });
        throw error; // Triggers BullMQ retry
    }
}, { connection, concurrency: 10 }); // Concurrency increased for scale

logger.info('WORKER', '✅ Instagram Automation Worker initialized');

module.exports = { commentWorker };
