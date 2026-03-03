const crypto = require('crypto');

// Uses a SHA-256 hash of the ENCRYPTION_KEY to ensure it's always exactly 32 bytes for AES-256
const getEncryptionKey = () => {
    const rawKey = process.env.ENCRYPTION_KEY || 'clora_ai_default_secret_key_change_in_prod';
    return crypto.createHash('sha256').update(rawKey).digest('base64').substring(0, 32);
};

const IV_LENGTH = 16;

const encryptToken = (text) => {
    if (!text) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = getEncryptionKey();
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);

        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);

        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (error) {
        console.error('Encryption failed:', error.message);
        return text;
    }
};

const decryptToken = (text) => {
    if (!text) return text;
    try {
        const textParts = text.split(':');
        // If it isn't split by colon, it probably isn't encrypted (fallback for old tokens)
        if (textParts.length !== 2) return text;

        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const key = getEncryptionKey();

        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);

        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString();
    } catch (error) {
        // Fallback to returning original text if decryption fails
        // This helps manage existing plain-text tokens seamlessly
        return text;
    }
};

module.exports = {
    encryptToken,
    decryptToken
};
