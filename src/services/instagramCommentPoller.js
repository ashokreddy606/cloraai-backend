const axios = require('axios');
const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { decryptToken } = require('../utils/cryptoUtils');
const { appConfig } = require('../config');
const { enqueueJob, commentQueue } = require('../utils/queue');

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';

/**
 * Polls Instagram API for recent comments for users who have active automation rules.
 * This function bypasses the unreliable webhook system by fetching recent comments 
 * on user's recent media and queueing them for processing if they haven't been responded to.
 */
const pollInstagramComments = async () => {
    logger.info('CRON:POLLER', 'Starting Instagram Comments API Polling...');

    try {
        if (!appConfig.featureFlags.autoDMEnabled) {
            logger.info('CRON:POLLER', 'Auto-DM feature flag is disabled. Skipping polling.');
            return;
        }

        // 1. Find all connected Instagram accounts belonging to users with active DM automations
        const accountsWithActiveRules = await prisma.instagramAccount.findMany({
            where: {
                isConnected: true,
                user: {
                    dmAutomations: {
                        some: {
                            isActive: true
                        }
                    }
                }
            },
            include: {
                user: true
            }
        });

        if (accountsWithActiveRules.length === 0) {
            logger.info('CRON:POLLER', 'No active accounts with automation rules found to poll.');
            return;
        }

        logger.info('CRON:POLLER', `Found ${accountsWithActiveRules.length} account(s) to poll.`);

        // 2. Poll for each account
        for (const account of accountsWithActiveRules) {
            try {
                const decryptedUserToken = decryptToken(account.instagramAccessToken);
                // The worker requires pageAccessToken for direct DMs and graph actions. 
                const decryptedPageToken = account.pageAccessToken ? decryptToken(account.pageAccessToken) : null;
                
                // Fetch recent 5 media objects
                const mediaUrl = `https://graph.instagram.com/${META_GRAPH_VERSION}/me/media?fields=id,shortcode,comments_count,timestamp&limit=5&access_token=${decryptedUserToken}`;
                const mediaResponse = await axios.get(mediaUrl);
                const mediaItems = mediaResponse.data.data;

                if (!mediaItems || mediaItems.length === 0) continue;

                // Filter media that actually have comments to avoid useless API calls
                // Even older posts might have fresh comments, so fetching recent 5 handles recent activity.
                // Large scale apps would store timestamps, but limit=5 is very API-friendly.
                const mediasWithComments = mediaItems.filter(m => m.comments_count > 0);

                for (const media of mediasWithComments) {
                    // Fetch recent 20 comments for this media (Reverse chronological order gets newest first)
                    // The Graph API limits this request easily without paginating forever
                    const commentsUrl = `https://graph.instagram.com/${META_GRAPH_VERSION}/${media.id}/comments?fields=id,text,timestamp,from{id,username},media{id}&order=reverse_chronological&limit=20&access_token=${decryptedUserToken}`;
                    
                    let commentsResponse;
                    try {
                        commentsResponse = await axios.get(commentsUrl);
                    } catch (err) {
                        logger.warn('CRON:POLLER', `Failed to fetch comments for media ${media.id}`, { error: err.response?.data?.error?.message || err.message });
                        continue;
                    }

                    const comments = commentsResponse.data.data;
                    if (!comments || comments.length === 0) continue;

                    for (const comment of comments) {
                        const senderId = comment.from?.id;
                        const commentId = comment.id;
                        const text = comment.text;
                        const mediaId = comment.media?.id || media.id;

                        if (!senderId || !commentId) continue;

                        // Prevent self-reply loops
                        if (senderId === account.instagramId) continue;

                        // Idempotency check: Have we processed this comment?
                        // Worker creates dmInteraction using format "comment_<commentId>"
                        const eventId = `comment_${commentId}`;
                        const existing = await prisma.dmInteraction.findUnique({ where: { messageId: eventId } });

                        if (existing) {
                            // Already processed, skip logic and move onto next comment
                            continue;
                        }

                        // NEW Comment Detected! Enqueue it to bullmq matching exact Webhook Payload Structure
                        logger.info('CRON:POLLER', `New unhandled comment detected: ${commentId} on media ${mediaId}`);
                        
                        await enqueueJob(commentQueue, 'process-comment', {
                            mediaId,
                            commentId,
                            commentText: text,
                            instagramId: account.instagramId,
                            senderId,
                            userId: account.userId,
                            instagramAccessToken: decryptedUserToken,
                            pageAccessToken: decryptedPageToken
                        });

                        logger.info('CRON:POLLER:QUEUED', `Queued comment ${commentId} for user ${account.userId} seamlessly`);
                    }
                }
            } catch (err) {
                logger.error('CRON:POLLER', `Error polling account ${account.instagramId}`, { error: err.response?.data?.error?.message || err.message });
                // If token expired (Error 190), we just skip. The daily Token-Refresh cron handles DB updates and disconnects.
            }
        }
    } catch (error) {
        logger.error('CRON:POLLER', 'Global poller failure', { error: error.message });
    }
};

module.exports = { pollInstagramComments };
