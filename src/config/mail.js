const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Verify connection configuration
transporter.verify((error, success) => {
    if (error) {
        console.error('Nodemailer configuration error:', error);
    } else {
        console.log('Nodemailer is ready to send emails');
    }
});

module.exports = transporter;
