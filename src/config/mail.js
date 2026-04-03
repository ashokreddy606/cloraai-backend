const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',   // Explicit host instead of 'service: gmail'
    port: 587,                // Port 587 with STARTTLS (Railway supports this)
    secure: false,            // false = STARTTLS, true = SSL (port 465 - blocked on Railway)
    family: 4,                // Force IPv4 to avoid ENETUNREACH on Railway
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false // Allow self-signed certs in some Railway environments
    }
});

// Verify connection configuration on startup
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!EMAIL_USER || !EMAIL_PASS || EMAIL_USER === 'CHANGE_ME' || EMAIL_PASS === 'CHANGE_ME') {
    logger.warn('MAIL', 'Nodemailer disabled: EMAIL_USER or EMAIL_PASS not configured in .env');
} else {
    transporter.verify((error, success) => {
        if (error) {
            console.error('❌ MAIL CONFIG ERROR:', error.message);
            if (error.responseCode === 535) {
                logger.error('MAIL', 'Authentication failed: Invalid credentials.', { 
                    tip: 'If using Gmail, ensure you have 2FA enabled and are using an APP PASSWORD, not your regular password.'
                });
            } else {
                logger.error('MAIL', 'Nodemailer configuration error', { error: error.message });
            }
        } else {
            logger.info('MAIL', 'Nodemailer is ready to send emails');
        }
    });
}

module.exports = transporter;
