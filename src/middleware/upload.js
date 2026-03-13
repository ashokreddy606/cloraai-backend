const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const os = require('os');
const { appConfig } = require('../config');

// S3 Client Setup
const awsAccessKeyId = (process.env.AWS_ACCESS_KEY_ID || 'dummy').trim();
const awsSecretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || 'dummy').trim();
const awsRegion = (process.env.AWS_REGION || 'us-east-1').trim();
const awsBucketName = (process.env.AWS_S3_BUCKET_NAME || 'cloraai-assets').trim();

console.log('[DEBUG_S3] Region:', awsRegion);
console.log('[DEBUG_S3] Bucket:', awsBucketName);
console.log('[DEBUG_S3] Access Key Loaded:', awsAccessKeyId !== 'dummy' ? 'YES (Starts with ' + awsAccessKeyId.substring(0, 4) + '...)' : 'NO (Dummy)');
console.log('[DEBUG_S3] Secret Key Loaded:', awsSecretAccessKey !== 'dummy' ? 'YES' : 'NO (Dummy)');

const s3 = new S3Client({
    region: awsRegion,
    credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
    }
});

// Allowed mimetypes
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];

// Helper to sanitize filenames
const sanitizeFileName = (originalname) => {
    return path.basename(originalname).replace(/[^a-zA-Z0-9.\-_]/g, '');
};

const getS3Storage = (folder) => multerS3({
    s3: s3,
    bucket: awsBucketName,
    acl: 'public-read',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${folder}/${uniqueSuffix}-${sanitizeFileName(file.originalname)}`);
    }
});

// Image Upload Middleware (Max 10MB)
const uploadImage = multer({
    storage: getS3Storage('images'),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid image type. Only JPEG, PNG, and WebP are allowed.'), false);
        }
    }
});

// Video Upload Middleware (S3, Max 200MB)
const uploadVideoS3 = multer({
    storage: getS3Storage('videos'),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
    fileFilter: (req, file, cb) => {
        if (ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid video type. Only MP4, MOV, and AVI are allowed.'), false);
        }
    }
});

// Local Temp Storage for YouTube/Processing (Max 200MB)
const uploadTempVideo = multer({
    dest: path.join(os.tmpdir(), 'cloraai-uploads'),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
    fileFilter: (req, file, cb) => {
        if (ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid video type. Only MP4, MOV, and AVI are allowed.'), false);
        }
    }
});

module.exports = {
    uploadImage,
    uploadVideoS3,
    uploadTempVideo,
    ALLOWED_IMAGE_TYPES,
    ALLOWED_VIDEO_TYPES
};
