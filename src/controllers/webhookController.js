const axios = require('axios');
const crypto = require('crypto');
const { appConfig } = require('../config');
const { decryptToken } = require('../utils/cryptoUtils');
const logger = require('../utils/logger');
const { analyzeAndSaveBrandDeal } = require('./brandDealController');

const prisma = require('../lib/prisma');
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;

if (!META_WEBHOOK_VERIFY_TOKEN) {
    console.error('[CRITICAL] META_WEBHOOK_VERIFY_TOKEN is not set. Webhooks will be rejected.');
}
if (!INSTAGRAM_APP_SECRET) {
    console.error('[CRITICAL] INSTAGRAM_APP_SECRET is not set. Webhook signature validation will be skipped!');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECURITY: Instagram POST Webhook Signature Validation
// Meta signs every POST body with HMAC-SHA256 using your
// App Secret and sends it in X-Hub-Signature-256 header.
// Rejecting unsigned requests prevents anyone from posting
// fake DM events that would trigger AI calls + DM replies.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const verifyInstagramSignature = (rawBody, signatureHeader) => {
    if (!INSTAGRAM_APP_SECRET) {
        // If secret is missing, log loudly but do not crash in dev
        logger.warn('WEBHOOK:SECURITY', 'INSTAGRAM_APP_SECRET not set — skipping signature check!');
        return process.env.NODE_ENV !== 'production'; // block in prod, allow in dev
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
        return false;
    }
    const receivedSig = signatureHeader.slice('sha256='.length);
    const expectedSig = crypto
        .createHmac('sha256', INSTAGRAM_APP_SECRET)
        .update(rawBody)
        .digest('hex');
    // Constant-time comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(
            Buffer.from(receivedSig, 'hex'),
            Buffer.from(expectedSig, 'hex')
        );
    } catch {
        return false; // Buffer length mismatch = invalid signature
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PART 1: Keyword matching with word boundaries
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const matchesKeyword = (incomingText, keyword) => {
    try {
        // Support comma-separated multi-keyword rules
        const keywords = keyword.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        return keywords.some(kw => {
            // Escape special regex chars, then use word boundaries
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'i');
            return regex.test(incomingText);
        });
    } catch {
        return false;
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: sleep()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Send message via Graph API with timeout
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const sendInstagramMessage = async (recipientId, messageText, accessToken, retryCount = 0) => {
    try {
        const url = `https://graph.instagram.com/v18.0/me/messages?access_token=${accessToken}`;
        await axios.post(url, {
            recipient: { id: recipientId },
            message: { text: messageText }
        }, { timeout: 10000 }); // PART 6: 10s hard timeout
    } catch (error) {
        const statusCode = error.response?.status;
        const errorCode = error.response?.data?.error?.code;

        // PART 6: Safe retry — max 2 attempts only
        if (retryCount < 2 && statusCode !== 429 && errorCode !== 190) {
            logger.warn('DM:SEND', `Send failed. Retrying (${retryCount + 1}/2)...`);
            await sleep(1000 * (retryCount + 1));
            return sendInstagramMessage(recipientId, messageText, accessToken, retryCount + 1);
        }
        // Log & track but never expose the token
        if (statusCode === 429) logger.increment('meta429Errors');
        logger.error('DM:SEND', `Failed to send DM to recipient`, { statusCode, errorCode });
        logger.increment('dmFailed');
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTES: Hub Verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTES: Incoming Message Events
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const handleWebhook = async (req, res) => {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // SECURITY: Validate X-Hub-Signature-256 BEFORE doing anything
    // Must use the raw body (Buffer), not the parsed JSON object
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const signatureHeader = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody; // Attached by raw body capture middleware in server.js

    if (!verifyInstagramSignature(rawBody || JSON.stringify(req.body), signatureHeader)) {
        logger.warn('WEBHOOK:SECURITY', 'Invalid Instagram webhook signature — request rejected', {
            ip: req.ip,
            hasHeader: !!signatureHeader,
        });
        logger.increment('webhookSignatureRejected');
        return res.sendStatus(403);
    }

    // Acknowledge Meta IMMEDIATELY to prevent retries from a slow response
    res.status(200).send('EVENT_RECEIVED');


    try {
        const { body } = req;

        if (body.object !== 'instagram') return;
        if (!appConfig.featureFlags.autoDMEnabled) return;

        // PART 5: Use `for...of` instead of `forEach` to prevent unbounded concurrency
        for (const entry of body.entry) {
            const messagingEvents = entry.messaging || [];

            for (const event of messagingEvents) {
                if (!event.message || !event.message.text || !event.message.mid) continue;

                const messageId = event.message.mid;
                const eventTimestampMs = event.timestamp * 1000;

                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // PART 4: Meta 24-Hour Compliance Enforcement
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
                if (Date.now() - eventTimestampMs > TWENTY_FOUR_HOURS_MS) {
                    logger.info('DM:COMPLIANCE', `Skipping message ${messageId} — outside 24-hour Meta policy window.`);
                    continue;
                }

                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // PART 2: Idempotency — Skip duplicates
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const existing = await prisma.dmInteraction.findUnique({ where: { messageId } });
                if (existing) {
                    logger.debug('DM:IDEMPOTENCY', `Message ${messageId} already processed. Skipping.`);
                    logger.increment('dmSkippedIdempotent');
                    continue;
                }

                const senderId = event.sender.id;
                const recipientId = event.recipient.id;

                const instagramAccount = await prisma.instagramAccount.findFirst({
                    where: { instagramUserId: recipientId },
                    include: {
                        user: {
                            select: {
                                id: true,
                                plan: true,
                                subscriptionStatus: true,
                                planEndDate: true,
                            }
                        }
                    }
                });

                if (!instagramAccount || !instagramAccount.isConnected) continue;

                const userId = instagramAccount.userId;
                const user = instagramAccount.user;

                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // PART 3: Daily DM Limit Enforcement (Rolling 24hr)
                // Source of truth: User.plan + subscriptionStatus + planEndDate
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const hasActiveSub =
                    (user.plan === 'LIFETIME') ||
                    (
                        user.plan === 'PRO' &&
                        user.subscriptionStatus === 'ACTIVE' &&
                        user.planEndDate &&
                        new Date(user.planEndDate) > new Date()
                    );

                const dailyDmLimit = hasActiveSub
                    ? (appConfig.aiLimits?.proDailyDMs ?? 500)
                    : (appConfig.aiLimits?.freeDailyDMs ?? 50);
                const windowStart = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);

                const sentToday = await prisma.dmInteraction.count({
                    where: {
                        userId,
                        createdAt: { gte: windowStart },
                        status: 'sent'
                    }
                });

                if (sentToday >= dailyDmLimit) {
                    logger.warn('DM:LIMIT', `User ${userId} reached daily DM limit (${dailyDmLimit}). Skipping.`);
                    logger.increment('dmSkippedLimit');
                    await prisma.dmInteraction.create({ data: { userId, messageId, status: 'skipped' } }).catch(() => { });
                    continue;
                }

                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // PART 1: Keyword Matching with Rule Priority
                // Rules sorted: longest keyword DESC (specificity)
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const rules = await prisma.dMAutomation.findMany({
                    where: { userId, isActive: true },
                    orderBy: [{ keyword: 'desc' }] // Sort by keyword length in-app after fetch
                });

                // Sort in memory: longest keyword first for correct specificity priority
                const sortedRules = rules.sort((a, b) => b.keyword.length - a.keyword.length);

                const incomingText = event.message.text.trim().toLowerCase().replace(/\s+/g, ' ');

                let matchedRule = null;
                for (const rule of sortedRules) {
                    if (matchesKeyword(incomingText, rule.keyword)) {
                        matchedRule = rule;
                        break; // Only ONE rule fires per message
                    }
                }

                // Async AI Brand Deal Analysis (fire-and-forget to not block webhook response times)
                analyzeAndSaveBrandDeal(event.message.text, senderId, userId).catch(() => { });

                if (!matchedRule) continue;

                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // PART 2 (cont): Reserve this messageId atomically BEFORE sending
                // This handles the race condition where two workers see the same event
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                try {
                    await prisma.dmInteraction.create({
                        data: { userId, messageId, ruleId: matchedRule.id, status: 'sent' }
                    });
                } catch (uniqueError) {
                    logger.debug('DM:RACE', `Message ${messageId} was claimed by a concurrent worker. Skipping.`);
                    logger.increment('dmSkippedIdempotent');
                    continue;
                }

                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // PART 5: Throttle — Add 100ms delay between outbound DM sends
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const decryptedToken = decryptToken(instagramAccount.accessToken);
                await sendInstagramMessage(senderId, matchedRule.autoReplyMessage, decryptedToken);
                await sleep(100);
                logger.info('DM:SENT', `Auto-replied using rule "${matchedRule.keyword}" for user ${userId}`);
                logger.increment('dmSent');
            }
        }
    } catch (error) {
        logger.error('WEBHOOK', 'Unhandled processing error', { error: error.message });
        logger.increment('webhookProcessingErrors');
    }
};

module.exports = { verifyWebhook, handleWebhook };
