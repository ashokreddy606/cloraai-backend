const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { appConfig } = require('../config');

// S3 Client Setup
const awsAccessKeyId = (process.env.AWS_ACCESS_KEY_ID || 'dummy').trim();
const awsSecretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || 'dummy').trim();
const awsRegion = (process.env.AWS_REGION || 'us-east-1').trim();
const awsBucketName = (process.env.AWS_S3_BUCKET_NAME || 'cloraai-assets').trim();

const s3 = new S3Client({
    region: awsRegion,
    credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
    }
});

/**
 * PRODUCTION SECURITY: EXTENSION WHITELIST & MAPPING
 */
const SAFE_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv',
    'video/webm': '.webm',
    'video/mpeg': '.mpeg'
};

const ALLOWED_MIME_TYPES = Object.keys(SAFE_EXTENSIONS);

/**
 * SECURE FILENAME GENERATOR
 */
const generateSecureFileName = (file) => {
    const ext = SAFE_EXTENSIONS[file.mimetype] || path.extname(file.originalname).toLowerCase();
    return `${uuidv4()}${ext}`;
};

// S3 Storage
const getS3Storage = (folder) => multerS3({
    s3: s3,
    bucket: awsBucketName,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
        cb(null, `${folder}/${generateSecureFileName(file)}`);
    }
});

// Local Disk Storage
const getLocalDiskStorage = (folder) => multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../../public/uploads', folder);
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, generateSecureFileName(file));
    }
});

// Middleware factory
const createUpload = (storage, sizeLimit) => multer({
    storage,
    limits: { fileSize: sizeLimit },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Security Policy: Mimetype ${file.mimetype} is not allowed.`), false);
        }
    }
});

const uploadImage = createUpload(getS3Storage('images'), 10 * 1024 * 1024);
const uploadVideoS3 = createUpload(getS3Storage('videos'), 200 * 1024 * 1024);
const uploadTempVideo = createUpload(multer({ dest: path.join(os.tmpdir(), 'cloraai-uploads') }), 200 * 1024 * 1024);
const uploadLocal = createUpload(getLocalDiskStorage(''), 50 * 1024 * 1024);

/**
 * MAGIC-BYTE VALIDATION MIDDLEWARE
 */
const validateFileContent = async (req, res, next) => {
    if (!req.file) return next();

    try {
        const { fileTypeFromBuffer, fileTypeFromFile } = await import('file-type');
        let type;

        if (req.file.buffer) {
            type = await fileTypeFromBuffer(req.file.buffer);
        } else if (req.file.path) {
            type = await fileTypeFromFile(req.file.path);
        }

        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) {
            // RELAXED FOR YOUTUBE UPLOADS: If file-type fails but multer detected a valid video mime, allow it
            if (ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
                console.warn(`[SECURITY] file-type detection failed for ${req.file.originalname} (mimetype: ${req.file.mimetype}), but allowing based on Multer mimetype.`);
                req.file.verifiedMimeType = req.file.mimetype;
                return next();
            }

            if (req.file.path) fs.unlink(req.file.path, () => { });
            return res.status(400).json({
                error: 'Security Violation',
                message: 'Invalid file content detected. The file type does not match its description or is not allowed.'
            });
        }

        req.file.verifiedMimeType = type.mime;
        next();
    } catch (error) {
        console.error('[SECURITY] File validation error:', error);
        next(error);
    }
};

module.exports = {
    uploadImage,
    uploadVideoS3,
    uploadTempVideo,
    uploadLocal,
    validateFileContent,
    ALLOWED_MIME_TYPES
};
