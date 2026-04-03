const axios = require('axios');
const crypto = require('crypto');
const { appConfig } = require('../config');
const { decryptToken } = require('../utils/cryptoUtils');
const logger = require('../utils/logger');
const { matchesKeyword } = require('../utils/automationUtils');

const { enqueueJob, commentQueue } = require('../utils/queue');

const prisma = require('../lib/prisma');
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

if (!META_WEBHOOK_VERIFY_TOKEN) {
    console.error('[CRITICAL] META_WEBHOOK_VERIFY_TOKEN is not set. Webhooks will be rejected.');
}
if (!INSTAGRAM_APP_SECRET) {
    console.error('[CRITICAL] INSTAGRAM_APP_SECRET is not set. Webhook signature validation will be skipped!');
}

/**
 * SECURITY: Validate X-Hub-Signature-256 header.
 * Meta signs POST bodies with HMAC-SHA256 using the App Secret.
 */
const verifyInstagramSignature = (rawBody, signatureHeader) => {
    if (!INSTAGRAM_APP_SECRET) {
        logger.warn('WEBHOOK:SECURITY', 'INSTAGRAM_APP_SECRET not set — skipping signature check!');
        return process.env.NODE_ENV !== 'production';
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
        return false;
    }

    if (!rawBody) {
        logger.error('WEBHOOK:SECURITY', 'Signature verification failed: rawBody missing. Ensure middleware is correctly configured.');
        return false;
    }

    const receivedSig = signatureHeader.slice('sha256='.length);
    const expectedSig = crypto
        .createHmac('sha256', INSTAGRAM_APP_SECRET)
        .update(rawBody)
        .digest('hex');

    try {
        const isValid = crypto.timingSafeEqual(
            Buffer.from(receivedSig, 'hex'),
            Buffer.from(expectedSig, 'hex')
        );

        if (!isValid) {
            logger.warn('WEBHOOK:SECURITY', 'Webhook signature mismatch detected', { ip: 'check-server-logs' });
        }
        return isValid;
    } catch (err) {
        logger.error('WEBHOOK:SECURITY', 'timingSafeEqual comparison error', { error: err.message });
        return false;
    }
};

/**
 * ROUTES: Hub Verification (GET)
 */
const verifyWebhook = (req, res) => {
    logger.info('WEBHOOK:VERIFY', 'Incoming Meta Handshake', { query: req.query });

    const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
    const mode = req.query['hub.mode'] || req.query['hub_mode'];
    const token = req.query['hub.verify_token'] || req.query['hub_verify_token'];
    const challenge = req.query['hub.challenge'] || req.query['hub_challenge'];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        logger.info('WEBHOOK:VERIFY', 'Handshake Successful', { challenge });
        return res.status(200).send(challenge);
    }

    logger.warn('WEBHOOK:VERIFY', 'Handshake Failed', { mode, tokenReceived: !!token });
    return res.sendStatus(403);
};

/**
 * HELPER: Resolve Instagram Account from Entry ID or Page ID
 * Robust fallback mechanism to prevent silent null failures.
 */
const resolveInstagramAccount = async (entryId, commentOwnerId = null) => {
    // Create a unique array of candidate IDs to check
    const candidateIds = [...new Set([entryId, commentOwnerId].filter(Boolean))];
    logger.debug('WEBHOOK:RESOLVE', 'Resolving Instagram account', { candidateIds });

    for (const id of candidateIds) {
        // 1. Try matching by instagramId (Instagram Business Account)
        let account = await prisma.instagramAccount.findFirst({
            where: { instagramId: id, isConnected: true }
        });

        if (account) {
            logger.debug('WEBHOOK:RESOLVE', 'Matched via instagramId', { instagramId: account.instagramId });
            return account;
        }

        // 2. Try matching by pageId (Meta Page Feed event object fallback)
        account = await prisma.instagramAccount.findFirst({
            where: { pageId: id, isConnected: true }
        });

        if (account) {
            logger.debug('WEBHOOK:RESOLVE', 'Matched via pageId', { pageId: account.pageId });
            return account;
        }
    }

    logger.warn('WEBHOOK:RESOLVE', 'No active Instagram account matched any candidate IDs', { candidateIds });
    return null;
};

/**
 * ROUTES: Handle Webhook Events (POST)
 */
const handleWebhook = async (req, res) => {
    const signatureHeader = req.headers['x-hub-signature-256'];

    logger.info('WEBHOOK:RECEIVED', 'Meta Webhook Event Received', { 
        path: req.originalUrl || req.url,
        hasSignature: !!signatureHeader,
        object: req.body?.object,
        entryCount: req.body?.entry?.length 
    });

    const isSignatureValid = verifyInstagramSignature(req.rawBody, signatureHeader);
    
    if (!isSignatureValid) {
        logger.warn('WEBHOOK:SECURITY', 'Invalid signature rejected', { ip: req.ip, hasHeader: !!signatureHeader });
        return res.sendStatus(403);
    }

    // 2. Immediate Acknowledgment (Meta requires 200 within 20s)
    res.status(200).send('EVENT_RECEIVED');

    try {
        const { body } = req;
        logger.info('WEBHOOK', `Processing ${body.object} event`, { entries: body.entry?.length });
        
        if (!appConfig.featureFlags.autoDMEnabled) {
            logger.info('WEBHOOK:SKIP', 'Auto-DM feature flag is disabled');
            return;
        }

        // Supported objects: 'instagram' (for DMs/Direct Comments) and 'page' (for Page Feed Comments)
        if (body.object !== 'instagram' && body.object !== 'page') {
            logger.info('WEBHOOK:IGNORED_OBJECT', `Ignored object type: ${body.object}`);
            return;
        }

        for (const entry of body.entry) {
            logger.info('WEBHOOK', `Processing entry ${entry.id}`);
            logger.info('WEBHOOK:RAW_PAYLOAD', 'Raw Entry Payload', { entry: JSON.stringify(entry) });
            
            // A. Handle Comments (Direct Instagram OR Page Feed)
            const changes = entry.changes || [];
            for (const change of changes) {
                const isInstagramComment = change.field === 'comments';
                const isPageFeedComment = change.field === 'feed' && change.value?.item === 'comment' && change.value.verb === 'add';

                if (isInstagramComment || isPageFeedComment) {
                    const comment = change.value;
                    logger.info('WEBHOOK:COMMENT', 'Comment event received', { commentId: comment.id || comment.comment_id });
                    
                    const commentId = comment.id || comment.comment_id;
                    const mediaId = comment.media?.id || comment.media_id || comment.post_id;
                    const senderId = comment.from?.id;
                    const text = comment.text || comment.message;

                    logger.info('COMMENT:DETECTED', 'New comment on media', { commentId, mediaId, senderId });

                    if (!senderId || !commentId) {
                        logger.warn('COMMENT:INCOMPLETE', 'Skipping incomplete comment data', { commentId, senderId });
                        continue;
                    }

                    // Resolve account: Resolve by entry.id, with comment block owner ID fallback
                    const account = await resolveInstagramAccount(entry.id, comment.from?.id);
                    
                    if (account) {
                        // Prevent self-reply loops
                        if (senderId === account.instagramId) {
                            logger.debug('COMMENT:SELF', `Skipping self-comment ${commentId}`);
                            continue;
                        }

                        const decryptedUserToken = decryptToken(account.instagramAccessToken);
                        const decryptedPageToken = account.pageAccessToken ? decryptToken(account.pageAccessToken) : null;

                        await enqueueJob(commentQueue, 'process-comment', {
                            mediaId,
                            commentId,
                            commentText: comment.text || comment.message,
                            instagramId: account.instagramId,
                            senderId,
                            userId: account.userId,
                            instagramAccessToken: decryptedUserToken,
                            pageAccessToken: decryptedPageToken
                        });
                        logger.info('QUEUE:JOB_CREATED', `Enqueued comment ${commentId} for user ${account.userId}`, { 
                            commentId, 
                            mediaId,
                            senderId
                        });
                    } else {
                        logger.warn('WEBHOOK:ACCOUNT_NOT_FOUND', `Could not resolve Instagram account for entry/page ${entry.id}`, { entryId: entry.id });
                    }
                }
            }

            // B. Handle Messaging (Direct Messages)
            const messagingEvents = entry.messaging || [];
            for (const event of messagingEvents) {
                if (!event.message?.text || !event.message?.mid) continue;

                const messageId = event.message.mid;
                const senderId = event.sender.id;
                const recipientId = event.recipient.id;

                const account = await resolveInstagramAccount(entry.id, recipientId);
                if (!account) {
                    logger.warn('WEBHOOK:ACCOUNT_NOT_FOUND', `Could not resolve Instagram account for recipient ${recipientId}`, { recipientId });
                    continue;
                }

                // Prevent self-reply loops
                if (senderId === account.instagramId) continue;

                // Enqueue DM processing
                const decryptedUserToken = decryptToken(account.instagramAccessToken);
                const decryptedPageToken = account.pageAccessToken ? decryptToken(account.pageAccessToken) : null;

                await enqueueJob(commentQueue, 'process-dm', {
                    messageId,
                    text: event.message.text,
                    senderId,
                    instagramId: account.instagramId,
                    userId: account.userId,
                    instagramAccessToken: decryptedUserToken,
                    pageAccessToken: decryptedPageToken
                });
                logger.info('QUEUE:JOB_CREATED', `Enqueued DM ${messageId} for user ${account.userId}`, { 
                    messageId, 
                    senderId 
                });
            }
        }
    } catch (error) {
        logger.error('WEBHOOK:ERROR', 'Error processing webhook', { error: error.message });
    }
};

module.exports = { verifyWebhook, handleWebhook };
