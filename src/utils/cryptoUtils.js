const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;

/**
 * SECURITY: Enforce TOKEN_ENCRYPTION_SECRET for OAuth tokens.
 */
let SECRET = process.env.TOKEN_ENCRYPTION_SECRET || process.env.ENCRYPTION_KEY;

if (!SECRET) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('CRYPTO:FAIL', 'CRITICAL SECURITY ERROR: TOKEN_ENCRYPTION_SECRET is missing in production. Server cannot start securely.');
        throw new Error('TOKEN_ENCRYPTION_SECRET must be set in production environments.');
    } else {
        logger.warn('CRYPTO:INSECURE', 'TOKEN_ENCRYPTION_SECRET is missing. Falling back to JWT_SECRET for development.');
        SECRET = process.env.JWT_SECRET || 'temporary_dev_fallback_secret_not_for_production';
    }
}

/**
 * Encrypts cleartext using AES-256-GCM.
 * Returns a string in the format: iv:authTag:encryptedContent
 * @param {string} text 
 * @returns {string} 
 */
function encrypt(text) {
    if (!text) return text;

    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        // Ensure key is 32 bytes for AES-256
        const key = crypto.createHash('sha256').update(SECRET).digest();
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag().toString('hex');

        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    } catch (error) {
        logger.error('CRYPTO', 'Encryption failed', { error: error.message });
        return text;
    }
}

/**
 * Decrypts a string in the format: iv:authTag:encryptedContent
 * @param {string} encryptedText 
 * @returns {string}
 */
function decrypt(encryptedText) {
    if (!encryptedText) return encryptedText;

    try {
        const parts = encryptedText.split(':');

        // If it doesn't have 3 parts (iv, tag, content), it might be old CBC or plain text
        if (parts.length !== 3) {
            // Check for old CBC format (iv:content)
            if (parts.length === 2) {
                return decryptCBC(encryptedText);
            }
            return encryptedText;
        }

        const [ivHex, authTagHex, encryptedContent] = parts;
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const key = crypto.createHash('sha256').update(SECRET).digest();

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedContent, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        logger.error('CRYPTO', 'Decryption failed: TOKEN_ENCRYPTION_SECRET likely changed or missing since data was stored.', { 
            error: error.message,
            secretUsed: SECRET ? `${SECRET.substring(0, 3)}***` : 'NONE'
        });
        return null;
    }
}

/**
 * Fallback for legacy AES-256-CBC tokens
 */
function decryptCBC(text) {
    try {
        const parts = text.split(':');
        if (parts.length !== 2) return text;

        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        const key = crypto.createHash('sha256').update(SECRET).digest();

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString();
    } catch (err) {
        return text;
    }
}

module.exports = {
    encrypt,
    decrypt,
    encryptToken: encrypt,  // Alias for backward compatibility
    decryptToken: decrypt   // Alias for backward compatibility
};
