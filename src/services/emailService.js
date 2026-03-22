/**
 * Email Service for CloraAI (Production Ready)
 */

const nodemailer = require('nodemailer');

// ✅ Create transporter (NO fallback, clean config)
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,              // smtp.gmail.com
    port: Number(process.env.EMAIL_PORT),      // 587 or 465
    secure: Number(process.env.EMAIL_PORT) === 465, // true for 465, false for 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

/**
 * Send Generic Email
 */
const sendEmail = async (to, subject, html) => {
    try {
        const info = await transporter.sendMail({
            from: `"CloraAI" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html,
        });

        console.log(`✅ Email sent to ${to}: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error("❌ EMAIL ERROR:", error);
        return false;
    }
};

/**
 * 🔐 Forgot Password Email
 */
const sendResetPasswordEmail = (user, resetLink) => {
    const subject = "Reset Your CloraAI Password";
    const html = `
    <h2>Hello ${user.username || "User"},</h2>
    <p>You requested to reset your password.</p>
    <p>Click the link below to reset it:</p>
    <a href="${resetLink}" target="_blank">${resetLink}</a>
    <p>If you didn't request this, ignore this email.</p>
    <br/>
    <p>— Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

/**
 * 💰 Payment Success
 */
const notifyPaymentSuccess = (user, planName) => {
    const subject = "Welcome to CloraAI Pro 🚀";
    const html = `
    <h2>Hello ${user.username || "User"},</h2>
    <p>Your payment for <strong>${planName}</strong> was successful.</p>
    <p>You now have PRO access 🎉</p>
    <br/>
    <p>— Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

/**
 * ❌ Payment Failed
 */
const notifyPaymentFailed = (user, planName) => {
    const subject = "Payment Failed - CloraAI";
    const html = `
    <h2>Hello ${user.username || "User"},</h2>
    <p>Your payment for <strong>${planName}</strong> failed.</p>
    <p>Please retry to continue using PRO features.</p>
    <br/>
    <p>— Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

/**
 * ⏳ Expiry Warning
 */
const notifyExpiryWarning = (user, daysLeft) => {
    const subject = "Your CloraAI Pro is Expiring Soon";
    const html = `
    <h2>Hello ${user.username || "User"},</h2>
    <p>Your subscription expires in <strong>${daysLeft} days</strong>.</p>
    <p>Renew now to avoid interruption.</p>
    <br/>
    <p>— Team CloraAI</p>
  `;
    return sendEmail(user.email, subject, html);
};

module.exports = {
    sendResetPasswordEmail,
    notifyPaymentSuccess,
    notifyPaymentFailed,
    notifyExpiryWarning,
};