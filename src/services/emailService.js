/**
 * Email Service for CloraAI (Gmail SMTP - Railway Fix)
 */

const nodemailer = require('nodemailer');

// ✅ Transporter (FORCE IPv4 - fixes ENETUNREACH)
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // required for 587
    family: 4,     // ⭐ VERY IMPORTANT (fixes Railway IPv6 issue)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// ✅ Verify connection (debug)
transporter.verify((err, success) => {
    if (err) {
        console.log("❌ SMTP ERROR:", err);
    } else {
        console.log("✅ SMTP SERVER READY");
    }
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
        console.error("❌ EMAIL SEND ERROR:", error);
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
    <p>You requested a password reset.</p>
    <p>Click below to reset your password:</p>
    <a href="${resetLink}" target="_blank">${resetLink}</a>
    <br/><br/>
    <p>If you didn’t request this, ignore this email.</p>
    <p>— Team CloraAI</p>
  `;

    return sendEmail(user.email, subject, html);
};

/**
 * 💰 Payment Success
 */
const notifyPaymentSuccess = (user, planName) => {
    return sendEmail(
        user.email,
        "Welcome to CloraAI Pro 🚀",
        `
    <h2>Hello ${user.username || "User"},</h2>
    <p>Your payment for <strong>${planName}</strong> was successful.</p>
    <p>You now have PRO access 🎉</p>
    <p>— Team CloraAI</p>
    `
    );
};

/**
 * ❌ Payment Failed
 */
const notifyPaymentFailed = (user, planName) => {
    return sendEmail(
        user.email,
        "Payment Failed - CloraAI",
        `
    <h2>Hello ${user.username || "User"},</h2>
    <p>Your payment for <strong>${planName}</strong> failed.</p>
    <p>Please retry to continue using PRO features.</p>
    <p>— Team CloraAI</p>
    `
    );
};

/**
 * ⏳ Expiry Warning
 */
const notifyExpiryWarning = (user, daysLeft) => {
    return sendEmail(
        user.email,
        "Your CloraAI Subscription is Expiring",
        `
    <h2>Hello ${user.username || "User"},</h2>
    <p>Your subscription expires in <strong>${daysLeft} days</strong>.</p>
    <p>Renew now to continue enjoying premium features.</p>
    <p>— Team CloraAI</p>
    `
    );
};

module.exports = {
    sendResetPasswordEmail,
    notifyPaymentSuccess,
    notifyPaymentFailed,
    notifyExpiryWarning,
};