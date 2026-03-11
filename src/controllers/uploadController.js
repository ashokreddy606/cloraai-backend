const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Configure storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../../public/uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomUUID();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}${ext}`);
    }
});

// File filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Unsupported file type. Only JPEG, PNG, WEBP, GIF, MP4, and MOV are allowed.'), false);
    }
};

const upload = multer({ 
    storage, 
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

/**
 * Handle direct file upload to local server
 */
const localUpload = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Generate public URL
        // We use req.get('host') to detect current server address
        const protocol = req.protocol;
        const host = req.get('host');
        const publicUrl = `${protocol}://${host}/public/uploads/${req.file.filename}`;

        logger.info('UPLOAD', `File uploaded locally by user ${req.userId}`, { 
            filename: req.file.filename,
            size: req.file.size
        });

        res.json({
            success: true,
            data: {
                publicUrl: publicUrl,
                filename: req.file.filename,
                mimetype: req.file.mimetype
            }
        });
    } catch (error) {
        logger.error('UPLOAD', 'Local upload failure:', error);
        res.status(500).json({ error: 'Failed to upload file', message: error.message });
    }
};

module.exports = { 
    localUpload,
    uploadMiddleware: upload.single('file')
};
