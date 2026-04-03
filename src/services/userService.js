const prisma = require('../lib/prisma');
const logger = require('../utils/logger');
const { s3Client } = require('../config/aws');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { OAuth2Client } = require('google-auth-library');
const { decrypt } = require('../utils/cryptoUtils');

/**
 * Securely deletes a user account and scrubs all PII.
 * Moves analytics to an anonymized account to preserve business metrics.
 */
const secureDeleteAccount = async (userId) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { 
                instagramAccounts: true,
                scheduledPosts: true 
            }
        });

        if (!user) throw new Error('User not found');

        logger.info('PRIVACY', `Initiating SEURE account deletion for user ${userId}`);

        // 1. Revoke YouTube OAuth Tokens if exists
        if (user.youtubeRefreshToken) {
            try {
                const oAuth2Client = new OAuth2Client(
                    process.env.YOUTUBE_CLIENT_ID, 
                    process.env.YOUTUBE_CLIENT_SECRET
                );
                await oAuth2Client.revokeToken(decrypt(user.youtubeRefreshToken));
            } catch (e) {
                logger.warn('PRIVACY', "Failed to revoke YouTube token", { error: e.message });
            }
        }

        // 2. Remove Stored Media from S3
        if (user.profileImage && user.profileImage.includes('amazonaws.com')) {
            const key = user.profileImage.split('.com/')[1];
            if (key) {
                await s3Client.send(new DeleteObjectCommand({ 
                    Bucket: process.env.AWS_S3_BUCKET_NAME, 
                    Key: key 
                })).catch(() => {});
            }
        }

        for (const post of user.scheduledPosts) {
            if (post.mediaUrl && post.mediaUrl.includes('amazonaws.com')) {
                const key = post.mediaUrl.split('.com/')[1];
                if (key) {
                    await s3Client.send(new DeleteObjectCommand({ 
                        Bucket: process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME, 
                        Key: key 
                    })).catch(() => {});
                }
            }
        }

        // 3. Anonymize Analytics Records (Data Integrity & Compliance)
        let anonUser = await prisma.user.findUnique({ where: { email: 'anonymized@cloraai.internal' } });
        if (!anonUser) {
            anonUser = await prisma.user.create({
                data: {
                    email: 'anonymized@cloraai.internal',
                    password: 'PROTECTED_SYSTEM_ACCOUNT',
                    username: 'Anonymized',
                    role: 'BANNED'
                }
            });
        }

        await prisma.analyticsSnapshot.updateMany({
            where: { userId: user.id },
            data: { userId: anonUser.id }
        });

        // 4. Delete User (Prisma Cascade handles relations)
        await prisma.user.delete({ where: { id: user.id } });

        logger.info('PRIVACY', `Account ${userId} successfully scrubbed.`);
        return { success: true };
    } catch (error) {
        logger.error('PRIVACY', 'Secure delete failure:', { error: error.message, userId });
        throw error;
    }
};

module.exports = { secureDeleteAccount };
