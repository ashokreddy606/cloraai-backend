const { Worker } = require('bullmq');
const { connection, QUEUES } = require('../utils/queue');
const logger = require('../utils/logger');
const axios = require('axios');
const prisma = require('../lib/prisma');
const { appConfig } = require('../config');
const { matchesKeyword } = require('../utils/automationUtils');
const { generateAIReply } = require('../utils/aiUtils');
const pushNotificationService = require('../services/pushNotificationService');

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

        // Notify user about token expiry
        await pushNotificationService.notifyTokenExpired(userId).catch(err => 
            logger.warn('WORKER:NOTIFY_ERROR', 'Failed to send token expiry notification', { error: err.message })
        );
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
    const { mediaId, commentId, commentText, messageId: dmMessageId, text: dmText, instagramId, senderId, instagramAccessToken, pageAccessToken, userId, forceRuleId } = job.data;
    
    // Standardize identification
    const isDM = !!dmMessageId;
    const eventId = isDM ? dmMessageId : `comment_${commentId}`;
    const incomingText = isDM ? dmText : commentText;

    // STEP 1 & 6: Log full job data and worker start
    console.log("WORKER RECEIVED JOB:", job.data);
    logger.info('WORKER:START', `Worker picked up ${isDM ? 'DM' : 'comment'} job: ${eventId}`, { jobId: job.id, data: job.data });
    
    if (!instagramAccessToken && !pageAccessToken) {
        logger.warn('WORKER:SKIP', `No valid access token available for job ${job.id}. Decryption might have failed.`, { userId });
        return { skipped: true, reason: 'Missing access tokens' };
    }

    try {
        if (!userId || !senderId || !incomingText) {
            logger.warn('WORKER:SKIP', `Missing payload data for job ${job.id}`, { userId, senderId, hasText: !!incomingText });
            return { skipped: true, reason: 'Missing payload data' };
        }

        console.log("COMMENT TEXT:", incomingText);

        // 1. Idempotency Check
        const existing = await prisma.dmInteraction.findUnique({ where: { messageId: eventId } });
        if (existing) {
            logger.info('WORKER:IDEMPOTENCY', `Event ${eventId} already processed. Skipping.`, { jobId: job.id });
            return { skipped: true, reason: 'Duplicate event' };
        }

        // 2. Resolve Automation Rules
        logger.info('WORKER:RULES', `Fetching rules for user ${userId}`, { jobId: job.id });
        let matchedRule = null;

        if (forceRuleId) {
            // Bypass keyword matching logic entirely if this is a Quick Reply callback
            matchedRule = await prisma.dMAutomation.findUnique({ where: { id: forceRuleId } });
            if (!matchedRule) {
                 logger.warn('WORKER:FORCE_RULE_NOT_FOUND', `Could not find forced rule ${forceRuleId}`);
                 return { success: true };
            }
            logger.info('WORKER:FORCE_RULE', `Using forced rule ${forceRuleId} (Follow Request bypass)`, { jobId: job.id });
            
            const apiTokenForVerification = pageAccessToken || instagramAccessToken;
            try {
                // strict API validation to verify if the user is ACTUALLY following before sending the product link
                const profileUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${senderId}?fields=name,is_user_follow_business&access_token=${apiTokenForVerification}`;
                const profileRes = await axios.get(profileUrl);
                const isFollowing = profileRes.data.is_user_follow_business;
                
                if (isFollowing) {
                    logger.info('WORKER:FOLLOW_VERIFIED', `User ${senderId} is following. Proceeding.`, { jobId: job.id });
                    // Critical: Turn off mustFollow so we actually send the link this time!
                    matchedRule.mustFollow = false;
                } else {
                    logger.info('WORKER:FOLLOW_DENIED', `User ${senderId} clicked 'I followed' but isn't following.`, { jobId: job.id });
                    
                    // Provide feedback that they need to actually follow!
                    const notifyUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${apiTokenForVerification}`;
                    
                    const retryQuickReplies = [{
                        content_type: "text",
                        title: "I have followed! ✅",
                        payload: `SEND_LINK:${matchedRule.id}`
                    }];

                    await axios.post(notifyUrl, {
                        recipient: { id: senderId },
                        message: { 
                            text: "I just checked, and it looks like you aren't following the page yet! 😅 Please hit Follow on my profile first, then tap the button below to verify and unlock your link.",
                            quick_replies: retryQuickReplies
                        }
                    });

                    // Notify user about Follow-Gate Block
                    try {
                        const profileUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${senderId}?fields=username&access_token=${apiTokenForVerification}`;
                        const profileRes = await axios.get(profileUrl);
                        const username = profileRes.data.username || 'A user';
                        
                        await pushNotificationService.notifyFollowGateBlock(userId, username);
                    } catch (err) {
                        logger.warn('WORKER:NOTIFY_ERROR', 'Failed to send follow-gate notification', { error: err.message });
                    }

                    return { success: true, bypassed: false };
                }
            } catch (err) {
                 logger.warn('WORKER:FOLLOW_CHECK_ERROR', `Could not verify follower status for ${senderId}. Defaulting to grant access.`, { error: err.message });
                 // If API fails (e.g. scope missing), default to trusting the user so we don't break the funnel during Meta outages
                 matchedRule.mustFollow = false;
            }
        } else {
            const rules = await prisma.dMAutomation.findMany({
                where: { userId, isActive: true }
            });
            
            logger.debug('WORKER:RULES_LOADED', `Loaded ${rules.length} active rules`, { jobId: job.id });

            // Rules prioritized by keyword length (most specific first)
            const sortedRules = rules.sort((a, b) => {
                const lenA = (a.keyword || '').length;
                const lenB = (b.keyword || '').length;
                return lenB - lenA;
            });

            for (const rule of sortedRules) {
                // STEP 4: Verify Reel Filtering with flexibility
                const isMatchReel = !rule.reelId || (mediaId && String(mediaId).includes(String(rule.reelId)));
                const isMatchKeyword = rule.triggerType === 'any' || matchesKeyword(incomingText, rule.keyword);
                
                logger.debug('WORKER:RULE_CHECK', `Checking rule: ${rule.keyword}`, { 
                    jobId: job.id, 
                    reelFilter: rule.reelId || 'GLOBAL', 
                    reelMatch: isMatchReel,
                    keywordMatch: isMatchKeyword
                });

                if (isMatchReel && isMatchKeyword) {
                    matchedRule = rule;
                    console.log("RULE MATCHED:", rule.keyword);
                    logger.info('WORKER:RULE_MATCHED', `Matched rule: ${rule.keyword}`, { jobId: job.id, ruleId: rule.id });
                    break;
                }
            }
        }

        if (!matchedRule) {
            console.log(`[WORKER:SKIPPED] No matching rule for text: ${incomingText.substring(0, 30)}...`);
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

        // 4. Prepare Reply (Private DM)
        let finalMessage = matchedRule.autoReplyMessage || '';
        
        // AI Generation override with Safety Checks
        if (matchedRule.isAI) {
            const { checkAILimit } = require('../middleware/aiLimiter');
            const feature = matchedRule.triggerType === 'keywords' ? 'caption' : 'brand_deal'; // Map to closest feature
            
            const limitCheck = await checkAILimit(userId, feature);
            
            if (limitCheck.allowed) {
                const aiReply = await generateAIReply(incomingText, {
                    userId,
                    feature,
                    productName: matchedRule.productName,
                    productDescription: matchedRule.productDescription,
                    productUrl: matchedRule.productUrl,
                    isDM: isDM
                });
                if (aiReply) finalMessage = aiReply;
            } else {
                logger.warn('WORKER:AI_LIMIT_HIT', `AI limit hit for user ${userId}. Falling back to static reply.`, { code: limitCheck.code });
                // Notify user
                await pushNotificationService.notifyAILimitHit(userId, feature).catch(err => 
                    logger.warn('WORKER:NOTIFY_ERROR', 'Failed to send AI limit notification', { error: err.message })
                );
            }
        }

        // Product Details formatting
        if (matchedRule.replyType === 'product' && matchedRule.productName) {
            const productBlock = `\n\nProduct: ${matchedRule.productName}${matchedRule.productUrl ? '\n' + matchedRule.productUrl : ''}`;
            finalMessage += productBlock;
        }

        if (matchedRule.appendLinks) {
            const links = [matchedRule.link1, matchedRule.link2, matchedRule.link3, matchedRule.link4].filter(Boolean);
            if (links.length > 0) finalMessage += '\n\n' + links.join('\n');
        }

        // Custom DM Button mapping for product message
        let productQuickReplies = [];
        if (matchedRule.dmButtonText && matchedRule.replyType !== 'product') {
            productQuickReplies.push({
                content_type: "text",
                title: matchedRule.dmButtonText.substring(0, 20),
                payload: "PRODUCT_BTN_CLICKED"
            });
        }

        let followMessagePayload = null;

        // Feature: "Ask user to follow before sending link"
        if (matchedRule.mustFollow) {
            let header = "Thanks for asking!";
            let subtext = "I've sent the link, but make sure to follow for more updates!";
            
            if (matchedRule.customFollowEnabled) {
                if (matchedRule.customFollowHeader) header = matchedRule.customFollowHeader;
                if (matchedRule.customFollowSubtext) subtext = matchedRule.customFollowSubtext;
            }
            
            let quickReplies = [];
            if (matchedRule.customFollowEnabled) {
                if (matchedRule.followButtonText) {
                    quickReplies.push({
                        content_type: "text",
                        title: matchedRule.followButtonText.substring(0, 20),
                        payload: `SEND_LINK:${matchedRule.id}`
                    });
                }
                if (matchedRule.followedButtonText) {
                    quickReplies.push({
                        content_type: "text",
                        title: matchedRule.followedButtonText.substring(0, 20),
                        payload: `SEND_LINK:${matchedRule.id}`
                    });
                }
            }

            if (quickReplies.length === 0) {
                quickReplies.push({
                    content_type: "text",
                    title: "I Followed!",
                    payload: `SEND_LINK:${matchedRule.id}`
                });
            }

            followMessagePayload = {
                text: `${header}\n\n${subtext}`.trim(),
                quick_replies: quickReplies
            };
        }

        // Pick a public reply for comments
        let publicReply = finalMessage; // Fallback to DM message
        if (matchedRule.publicReplies) {
            try {
                const choices = JSON.parse(matchedRule.publicReplies);
                if (Array.isArray(choices) && choices.length > 0) {
                    publicReply = choices[Math.floor(Math.random() * choices.length)];
                }
            } catch (e) {
                logger.warn('WORKER:PARSE_PUBLIC', 'Failed to parse public replies', { ruleId: matchedRule.id });
            }
        }

        // 5. Execute API Calls (Private Reply then Public Reply for comments)
        const apiTokenForDM = pageAccessToken || instagramAccessToken;
        const dmUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${apiTokenForDM}`;
        
        try {
            // STEP A: Send Follow Request if enabled
            // The product link will NOT be sent until they click the Quick Reply button (handled via Webhook)
            if (followMessagePayload) {
                logger.info('WORKER:API_DM', `Sending Follow Request before link for ${eventId}`, { jobId: job.id });
                await axios.post(dmUrl, {
                    recipient: isDM ? { id: senderId } : { comment_id: commentId },
                    message: followMessagePayload
                });
                logger.info('WORKER:API_DM', `Halting flow to wait for user to click follow button...`);
            } else {
                // STEP B: Send Main Product Link / Message
                logger.info('WORKER:API_DM', `Sending main message for ${eventId}`, { jobId: job.id });
                
                const productPayload = { text: finalMessage };
                if (productQuickReplies.length > 0) {
                    productPayload.quick_replies = productQuickReplies;
                }

                const mainRecipient = isDM ? { id: senderId } : { comment_id: commentId };

                const response = await axios.post(dmUrl, {
                    recipient: mainRecipient,
                    message: productPayload
                });

                logger.info('WORKER:DM_SENT', `Direct message flow completed for ${eventId}`, { 
                    jobId: job.id,
                    metaResponse: response.data 
                });
                console.log(`[WORKER:API_SUCCESS] DM Sent for event ${eventId}`);
                logger.increment('dmSent');

                // Notify user about Automation Win
                try {
                    const profileUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${senderId}?fields=username&access_token=${apiTokenForDM}`;
                    const profileRes = await axios.get(profileUrl);
                    const username = profileRes.data.username || 'A user';
                    const keyword = matchedRule.keyword || 'your post';

                    await pushNotificationService.notifyAutomationWin(userId, username, keyword);
                } catch (err) {
                    logger.warn('WORKER:NOTIFY_ERROR', 'Failed to send automation win notification', { error: err.message });
                }
            }
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
                const response = await axios.post(replyUrl, { message: publicReply }, { params: { access_token: apiTokenForDM } });
                logger.info('WORKER:REPLY_SENT', `Public comment reply sent for ${eventId}`, { 
                    jobId: job.id,
                    metaResponse: response.data 
                });
                console.log("PUBLIC COMMENT SENT");
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
