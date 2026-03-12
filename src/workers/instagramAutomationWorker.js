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

    // STEP 1 & 6: Log full job data and worker start
    logger.info('WORKER:START', `Worker picked up ${isDM ? 'DM' : 'comment'} job: ${eventId}`, { jobId: job.id, data: job.data });

    try {
        if (!userId || !senderId || !incomingText) {
            logger.warn('WORKER:SKIP', `Missing payload data for job ${job.id}`, { userId, senderId, hasText: !!incomingText });
            return { skipped: true, reason: 'Missing payload data' };
        }

        // 1. Idempotency Check
        const existing = await prisma.dmInteraction.findUnique({ where: { messageId: eventId } });
        if (existing) {
            logger.info('WORKER:IDEMPOTENCY', `Event ${eventId} already processed. Skipping.`, { jobId: job.id });
            return { skipped: true, reason: 'Duplicate event' };
        }

        // 2. Resolve Automation Rules
        logger.info('WORKER:RULES', `Fetching rules for user ${userId}`, { jobId: job.id });
        const rules = await prisma.dMAutomation.findMany({
            where: { userId, isActive: true }
        });
        
        logger.debug('WORKER:RULES_LOADED', `Loaded ${rules.length} active rules`, { jobId: job.id });

        // Rules prioritized by keyword length (most specific first)
        const sortedRules = rules.sort((a, b) => b.keyword.length - a.keyword.length);

        let matchedRule = null;
        for (const rule of sortedRules) {
            // STEP 4: Verify Reel Filtering with flexibility
            const isMatchReel = !rule.reelId || (mediaId && mediaId.includes(rule.reelId));
            const isMatchKeyword = matchesKeyword(incomingText, rule.keyword);
            
            logger.debug('WORKER:RULE_CHECK', `Checking rule: ${rule.keyword}`, { 
                jobId: job.id, 
                reelFilter: rule.reelId || 'GLOBAL', 
                reelMatch: isMatchReel,
                keywordMatch: isMatchKeyword
            });

            if (isMatchReel && isMatchKeyword) {
                matchedRule = rule;
                logger.info('WORKER:RULE_MATCHED', `Matched rule: ${rule.keyword}`, { jobId: job.id, ruleId: rule.id });
                break;
            }
        }

        if (!matchedRule) {
            logger.info('WORKER:SKIPPED', `No matching rule for ${isDM ? 'DM' : 'comment'} ${eventId}`, { jobId: job.id, incomingText });
            return { success: true, matched: false };
        }

        // 3. Atomically claim this event
        try {
            await prisma.dmInteraction.create({
                data: { userId, messageId: eventId, ruleId: matchedRule.id, status: 'sent' }
            });
        } catch (err) {
            logger.warn('WORKER:CONFLICT', `Event ${eventId} claimed by another worker`, { jobId: job.id });
            return { skipped: true, reason: 'Event claimed by another worker' };
        }

        // 4. Prepare Reply
        let finalMessage = matchedRule.autoReplyMessage;
        if (matchedRule.appendLinks) {
            const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
            if (links.length > 0) finalMessage += '\n\n' + links.join('\n');
        }

        // 5. Execute API Calls (Private Reply then Public Reply for comments)
        const dmUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${instagramAccessToken}`;
        const dmRecipient = isDM ? { id: senderId } : { comment_id: commentId };

        try {
            logger.info('WORKER:API_DM', `Sending ${isDM ? 'DM' : 'Private'} reply for ${eventId}`, { 
                recipient: dmRecipient,
                jobId: job.id
            });
            const response = await axios.post(dmUrl, {
                recipient: dmRecipient,
                message: { text: finalMessage }
            });
            logger.info('WORKER:DM_SENT', `Direct message sent for ${eventId}`, { 
                jobId: job.id,
                metaResponse: response.data 
            });
            logger.increment('dmSent');
        } catch (err) {
            await handleMetaError(err, userId, instagramId);
            logger.error('WORKER:ERROR_DM', `DM failed for ${eventId}`, { 
                jobId: job.id,
                error: err.response?.data || err.message 
            });
            logger.increment('dmFailed');
            throw err; // Retry
        }

        // For comments, also send a public reply
        if (!isDM) {
            await sleep(150); // Safety delay between API calls

            const replyUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${commentId}/replies`;
            try {
                logger.info('WORKER:API_REPLY', `Sending public comment reply for ${commentId}`, { jobId: job.id });
                const response = await axios.post(replyUrl, { message: finalMessage }, { params: { access_token: instagramAccessToken } });
                logger.info('WORKER:REPLY_SENT', `Public comment reply sent for ${eventId}`, { 
                    jobId: job.id,
                    metaResponse: response.data 
                });
            } catch (err) {
                await handleMetaError(err, userId, instagramId);
                logger.error('WORKER:ERROR_REPLY', `Public reply failed for ${commentId}`, { 
                    jobId: job.id,
                    error: err.response?.data || err.message 
                });
            }
        }

        logger.info('WORKER:SUCCESS', `Automation completed for ${eventId}`, { jobId: job.id });
        return { success: true };

    } catch (error) {
        logger.error('WORKER:JOB_FAILED', `Job failed for ${eventId}:`, { 
            jobId: job.id,
            error: error.message,
            stack: error.stack
        });
        throw error; // Triggers BullMQ retry
    }
}, { connection, concurrency: 10 });

logger.info('WORKER', '✅ Instagram Automation Worker initialized');

module.exports = { commentWorker };
