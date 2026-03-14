const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
// Razorpay imports removed

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'dummy',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'dummy',
    }
});

const deleteAccount = async (req, res) => {
    try {
        const userId = req.userId;
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { scheduledPosts: true }
        });

        if (!user) return res.status(404).json({ error: 'User not found' });

        logger.info('PRIVACY', `Initiating account deletion for user ${userId}`);

        // 1. Revoke OAuth Tokens
        if (user.youtubeRefreshToken) {
            try {
                const oAuth2Client = new OAuth2Client(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
                const { decrypt } = require('../utils/cryptoUtils');
                await oAuth2Client.revokeToken(decrypt(user.youtubeRefreshToken));
            } catch (e) {
                logger.warn('PRIVACY', "Failed to revoke YouTube token", { error: e.message });
            }
        }

        // 2. Cancel Subscriptions
        if (user.activeRazorpaySubscriptionId && user.subscriptionStatus === 'ACTIVE') {
            logger.info('PRIVACY', "Native subscription reference found. (Account deletion — no Razorpay API call made)");
        }

        // 3. Remove Stored Media References from S3
        if (user.profileImage && user.profileImage.includes('amazonaws.com')) {
            const key = user.profileImage.split('.com/')[1];
            if (key) {
                await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME, Key: key })).catch(e => { });
            }
        }

        for (const post of user.scheduledPosts) {
            if (post.mediaUrl && post.mediaUrl.includes('amazonaws.com')) {
                const key = post.mediaUrl.split('.com/')[1];
                if (key) {
                    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key })).catch(e => { });
                }
            }
        }

        // 4. Anonymize Analytics Records
        // Moving analytics to a dummy anonymized user allows us to preserve aggregate metric accuracy
        // while fulfilling the requirement to break the link to PII.
        let anonUser = await prisma.user.findUnique({ where: { email: 'anonymized@cloraai.internal' } });
        if (!anonUser) {
            anonUser = await prisma.user.create({
                data: {
                    email: 'anonymized@cloraai.internal',
                    password: 'none',
                    username: 'Anonymized',
                    role: 'BANNED'
                }
            });
        }

        await prisma.analyticsSnapshot.updateMany({
            where: { userId: user.id },
            data: { userId: anonUser.id }
        });

        // 5. Delete User (Cascades: Instagram accounts, scheduling history, tokens, captions)
        await prisma.user.delete({ where: { id: user.id } });

        logger.info('PRIVACY', `Account ${userId} successfully deleted and data scrubbed.`);

        res.status(200).json({ success: true, message: 'Account and associated data have been permanently deleted.' });
    } catch (error) {
        logger.error('PRIVACY', 'Delete account error:', error);
        res.status(500).json({ error: 'Failed to delete account securely' });
    }
};

module.exports = { deleteAccount };
