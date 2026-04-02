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
transporter.verify((error, success) => {
    if (error) {
        logger.error('MAIL', 'Nodemailer configuration error', { error: error.message });
    } else {
        logger.info('MAIL', 'Nodemailer is ready to send emails');
    }
});

module.exports = transporter;
