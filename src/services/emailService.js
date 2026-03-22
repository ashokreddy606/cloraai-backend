/**
 * Email Service for CloraAI
 * Handles transactional emails for payments and subscriptions.
 */

const nodemailer = require('nodemailer');

// Mock transporter - you should replace this with real SMTP (SendGrid, Mailtrap, etc.)
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.ethereal.email',
    port: process.env.EMAIL_PORT || 587,
    family: 4, // Force IPv4 to avoid ENETUNREACH on Railway/IPv6 systems
    auth: {
        user: process.env.EMAIL_USER || 'mock_user',
        pass: process.env.EMAIL_PASS || 'mock_pass',
    },
    // Required for Gmail SMTP in some environments
    secure: process.env.EMAIL_PORT == 465,
    tls: {
        rejectUnauthorized: false
    }
});

/**
 * Sends a generic payment/subscription email.
 */
const sendEmail = async (to, subject, html) => {
    try {
        const info = await transporter.sendMail({
            from: '"CloraAI Payments" <noreply@cloraai.com>',
            to,
            subject,
            html,
        });
        console.log(`[EmailService] Email sent to ${to}: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error(`[EmailService] Failed to send email to ${to}:`, error);
        return false;
    }
};

const notifyPaymentSuccess = (user, planName) => {
    const subject = `Welcome to CloraAI Pro! 🚀`;
    const html = `
    <h1>Hello ${user.username || 'User'},</h1>
    <p>Your payment for the <strong>${planName}</strong> plan was successful.</p>
    <p>Your account has been upgraded to PRO. Enjoy your new features!</p>
    <p>Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

const notifyPaymentFailed = (user, planName) => {
    const subject = `Payment Failed - CloraAI`;
    const html = `
    <h1>Hello ${user.username || 'User'},</h1>
    <p>We were unable to process your payment for the <strong>${planName}</strong> plan.</p>
    <p>Please log in to the app and retry the payment to keep your Pro access.</p>
    <p>Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

const notifyExpiryWarning = (user, daysLeft) => {
    const subject = `Your CloraAI Pro subscription is expiring soon`;
    const html = `
    <h1>Hello ${user.username || 'User'},</h1>
    <p>Your Pro subscription will expire in <strong>${daysLeft} days</strong>.</p>
    <p>Renew now to continue using all our premium features.</p>
    <p>Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

module.exports = {
    notifyPaymentSuccess,
    notifyPaymentFailed,
    notifyExpiryWarning
};
