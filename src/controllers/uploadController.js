const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const logger = require('../utils/logger');

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'dummy',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'dummy',
    }
});

const generatePresignedUrl = async (req, res) => {
    try {
        const { fileName, fileType, folder = 'uploads' } = req.body;

        if (!fileName || !fileType) {
            return res.status(400).json({ error: 'fileName and fileType are required' });
        }

        // Validate fileType to prevent malicious uploads (XSS via SVG, reverse shells via scripts, etc)
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'];
        if (!allowedTypes.includes(fileType)) {
            logger.warn('SECURITY', `Attempted unsupported file upload: ${fileType} by user ${req.userId}`);
            return res.status(400).json({ error: 'Unsupported file type. Only JPEG, PNG, WEBP, GIF, MP4, and MOV are allowed.' });
        }

        // Sanitize filename to prevent directory traversal
        const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const ext = safeFileName.split('.').pop();

        // Ensure isolation by user ID
        const uniqueId = crypto.randomUUID();
        const key = `${folder}/${req.userId}/${uniqueId}.${ext}`;

        const command = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: key,
            ContentType: fileType,
        });

        // URL strictly expires in 5 minutes
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        const publicUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;

        logger.info('UPLOAD', `Generated S3 presigned URL for user ${req.userId}`, { key });

        res.json({
            success: true,
            data: {
                uploadUrl: signedUrl,
                publicUrl: publicUrl,
                key: key,
                expiresIn: 300
            }
        });
    } catch (error) {
        logger.error('UPLOAD', 'Failed to generate presigned URL:', error);
        res.status(500).json({ error: 'Failed to generate upload URL' });
    }
};

module.exports = { generatePresignedUrl };
