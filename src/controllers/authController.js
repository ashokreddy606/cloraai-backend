const prisma = require('../lib/prisma');
const { generateToken, hashPassword, verifyPassword } = require('../utils/helpers');
const { catchAsync, AppError } = require('../utils/errors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

// ─────────────────────────────────────────────
// Email: supports Resend API (recommended) OR Gmail SMTP (fallback)
// Set on Railway:
//   RESEND_API_KEY=re_xxxxxxxxxxxx         ← preferred (free at resend.com)
//   OR
//   SMTP_USER=yourgmail@gmail.com           ← Gmail App Password
//   SMTP_PASS=your-16-char-app-password
// ─────────────────────────────────────────────
const sendEmail = async ({ to, subject, html }) => {
  // Option 1: Resend API (recommended — free 3000/month, no app password needed)
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Resend requires a verified domain OR their testing sandbox address
        from: process.env.EMAIL_FROM || 'CloraAI <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
    return data;
  }

  // Option 2: Gmail SMTP (needs Google App Password — NOT your regular password)
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter.sendMail({
      from: process.env.EMAIL_FROM || `CloraAI <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
  }

  // No email provider configured
  throw new Error('No email provider configured. Set RESEND_API_KEY or SMTP_USER+SMTP_PASS on Railway.');
};


// User Registration
const register = catchAsync(async (req, res, next) => {
  if (!req || !req.body) {
    throw new AppError('Request body is missing or empty', 400);
  }

  // Always normalise email — prevents duplicate accounts with different casing
  const email = (req.body.email || '').toLowerCase().trim();
  const { password, username, deviceFingerprint, referredByCode, tosAccepted } = req.body;
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

  // FIX 18: Reject if TOS not accepted
  if (!tosAccepted) {
    throw new AppError('You must accept the Terms of Service to register', 400);
  }

  // Validation
  if (!email || !password || password.length < 8) {
    throw new AppError('Email and password (min 8 chars) are required', 400);
  }

  // Check if user exists
  const existingUser = await prisma.user.findUnique({
    where: { email }
  });

  if (existingUser) {
    throw new AppError('Email is already registered', 409);
  }

  // Process referral if provided
  let referredById = null;
  if (referredByCode) {
    const inviter = await prisma.user.findFirst({
      where: { referralCode: referredByCode }
    });
    if (inviter) {
      referredById = inviter.id;
    }
  }

  // Hash password
  const hashedPassword = await hashPassword(password);

  // Generate unique referral code for this new user
  const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4);

  // Create user
  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email,
        password: hashedPassword,
        username: username || email.split('@')[0],
        referralCode,
        referredById,
        ipAddress,
        deviceFingerprint: deviceFingerprint || null,
        // FIX 18: Record TOS acceptance
        tosAccepted: true,
        tosAcceptedAt: new Date(),
        // FIX 19: Setup email verification
        isEmailVerified: false,
        emailVerificationToken: crypto.randomBytes(32).toString('hex'),
        // Role assigned from DB only — never hardcoded based on email
        role: 'USER'
      }
    });

    if (referredById) {
      await tx.user.update({
        where: { id: referredById },
        data: { totalReferrals: { increment: 1 } }
      });
    }

    return newUser;
  });

  // Generate token
  const token = generateToken(user.id);

  // FIX 19: Send verification email
  const verifyLink = `${process.env.FRONTEND_URL || 'https://cloraai-backend-production.up.railway.app'}/verify-email?token=${user.emailVerificationToken}`;
  const emailHtml = `<!DOCTYPE html><html><body>
    <h2>Welcome to CloraAI, ${user.username}!</h2>
    <p>Please verify your email address to access all features.</p>
    <a href="${verifyLink}" style="padding:10px 20px; background:#4F46E5; color:white; text-decoration:none; border-radius:5px;">Verify Email</a>
  </body></html>`;

  try {
    await sendEmail({ to: user.email, subject: 'Welcome to CloraAI - Verify Email', html: emailHtml });
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
  }

  res.status(201).json({
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        username: user.username
      },
      token
    }
  });
});


// User Login
const login = async (req, res) => {
  try {
    // Always normalise email — must match normalised value stored at registration
    const email = (req.body.email || '').toLowerCase().trim();
    const { password, deviceFingerprint } = req.body;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

    if (!email || !password) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Email and password are required'
      });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    const INVALID_CREDS = { error: 'Invalid credentials', message: 'Invalid email or password' };
    const LOCKED_OUT = { error: 'Account locked', message: 'Too many failed login attempts. Please try again after 30 minutes.' };

    if (!user) {
      return res.status(401).json(INVALID_CREDS);
    }

    // Check Lockout Status
    if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
      return res.status(403).json(LOCKED_OUT);
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.password);

    if (!passwordValid) {
      // Increment failed attempts
      const newAttempts = user.failedLoginAttempts + 1;
      const lockoutUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;

      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: newAttempts, lockoutUntil }
      });

      if (lockoutUntil) {
        return res.status(403).json(LOCKED_OUT);
      }
      return res.status(401).json(INVALID_CREDS);
    }

    // If password is valid but 2FA is enabled, return 2FA prompt
    if (user.twoFactorEnabled) {
      // Send a temporary token for 2FA validation
      const tempToken = generateToken(user.id, user.tokenVersion);
      return res.status(200).json({
        success: true,
        requires2FA: true,
        tempToken,
        message: 'Two-factor authentication required.'
      });
    }

    // Generate token with tokenVersion (Phase 1 Fix)
    const token = generateToken(user.id, user.tokenVersion);

    // Update login analytics
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ipAddress,
        ...(deviceFingerprint && { deviceFingerprint }),
        failedLoginAttempts: 0,
        lockoutUntil: null,
      }
    });

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          profileImage: user.profileImage,
          role: user.role
        },
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Login failed',
      message: 'Internal server error'
    });
  }
};

// Get Current User (Profile /me)
const getCurrentUser = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: {
        instagramAccounts: { select: { username: true, isConnected: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Compute daysRemaining
    let daysRemaining = null;
    if (user.plan === 'LIFETIME') {
      daysRemaining = null; // unlimited
    } else if (user.planEndDate) {
      const diff = new Date(user.planEndDate) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    // Lazy expiry: if plan expired but cron hasn't run yet, fix it now
    if (
      user.plan === 'PRO' &&
      user.subscriptionStatus === 'ACTIVE' &&
      user.planEndDate &&
      new Date(user.planEndDate) < new Date()
    ) {
      await prisma.user.update({
        where: { id: req.userId },
        data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' },
      });
      user.plan = 'FREE';
      user.subscriptionStatus = 'EXPIRED';
      daysRemaining = 0;
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          profileImage: user.profileImage,
          role: user.role,
          phoneNumber: user.phoneNumber,
          instagramConnected: user.instagramAccounts?.some(a => a.isConnected) ?? false,
          // ── Subscription Plan Data ──────────────────────────────────
          plan: user.plan,                            // FREE | PRO | LIFETIME
          subscriptionStatus: user.subscriptionStatus, // ACTIVE | EXPIRED | CANCELLED | PAST_DUE | null
          planSource: user.planSource,                // RAZORPAY | ADMIN | REFERRAL | null
          planStartDate: user.planStartDate,
          planEndDate: user.planEndDate,
          daysRemaining,                              // null = LIFETIME, 0 = expired, N = days left
          manuallyUpgraded: user.manuallyUpgraded,
        },
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Failed to fetch user',
      message: 'Internal server error',
    });
  }
};


// Update Profile
const updateProfile = async (req, res) => {
  try {
    const { username, phoneNumber, profileImage } = req.body;

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(username && { username }),
        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }),
        ...(profileImage !== undefined && { profileImage: profileImage || null }),
      }
    });

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          profileImage: user.profileImage,
          phoneNumber: user.phoneNumber,
        }
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      error: 'Failed to update profile',
      message: error.message
    });
  }
};

// Logout (client-side token deletion)
const logout = async (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully'
  });
};

// Forgot Password
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success to prevent email enumeration
    if (user) {
      // Generate cryptographically secure reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any existing tokens for this user
      await prisma.passwordReset.updateMany({
        where: { userId: user.id, used: false },
        data: { used: true }
      });

      // Store token in DB
      await prisma.passwordReset.create({
        data: {
          userId: user.id,
          token: resetToken,
          expiresAt
        }
      });

      const resetLink = `${process.env.FRONTEND_URL || 'https://cloraai-backend-production.up.railway.app'}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

      const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
      <body style="margin:0;padding:0;background:#0B1020;font-family:Arial,sans-serif;">
        <div style="max-width:560px;margin:40px auto;background:#111827;border-radius:20px;overflow:hidden;border:1px solid #1F2937;">
          <div style="background:linear-gradient(135deg,#6D28D9,#4F46E5);padding:32px;text-align:center;">
            <h1 style="color:#fff;font-size:28px;margin:0;font-weight:900;">CloraAI ✦</h1>
          </div>
          <div style="padding:32px;">
            <h2 style="color:#FFFFFF;font-size:22px;margin-bottom:12px;">Reset Your Password</h2>
            <p style="color:#9CA3AF;font-size:15px;line-height:24px;">
              Hi <strong style="color:#FFFFFF;">${user.username || 'there'}</strong>,<br><br>
              We received a request to reset the password for your CloraAI account
              (<strong style="color:#A78BFA;">${email}</strong>).
            </p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${resetLink}"
                 style="background:linear-gradient(135deg,#6D28D9,#4F46E5);color:#FFFFFF;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700;display:inline-block;">
                Reset Password &rarr;
              </a>
            </div>
            <p style="color:#6B7280;font-size:13px;text-align:center;">
              This link expires in 1 hour. If you didn't request a reset, ignore this email.
            </p>
          </div>
          <div style="padding:20px;text-align:center;border-top:1px solid #1F2937;">
            <p style="color:#4B5563;font-size:12px;margin:0;">&copy; 2026 CloraAI. All rights reserved.</p>
          </div>
        </div>
      </body></html>`;

      try {
        await sendEmail({ to: email, subject: 'Reset Your CloraAI Password', html: emailHtml });
        console.log(`✅ Password reset email sent to ${email}`);
      } catch (emailErr) {
        // Log reset link to Railway logs so dev can copy it during testing
        console.error('⚠️  Email send failed:', emailErr.message);
        console.log(`📧 RESET LINK (copy from Railway logs): ${resetLink}`);
      }
    } // End of if (user)

    res.status(200).json({
      success: true,
      message: 'If an account with that email exists, a reset link has been sent.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
};

// Reset Password (verify token + set new password)
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword || newPassword.length < 8) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Token and new password (min 8 chars) are required'
      });
    }

    // Find valid, unused token
    const resetRecord = await prisma.passwordReset.findUnique({
      where: { token }
    });

    if (!resetRecord || resetRecord.used || resetRecord.expiresAt < new Date()) {
      return res.status(400).json({
        error: 'Invalid or expired token',
        message: 'This reset link is invalid or has expired. Please request a new one.'
      });
    }

    // Hash new password and update user
    const hashedPassword = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: resetRecord.userId },
      data: { password: hashedPassword }
    });

    // Mark token as used
    await prisma.passwordReset.update({
      where: { id: resetRecord.id },
      data: { used: true }
    });

    res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now sign in with your new password.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
};

// Delete Account (mandatory for Play Store 2024+)
const deleteAccount = async (req, res) => {
  try {
    const userId = req.userId;

    // Prisma cascade deletes will handle related records
    // (CalendarTask, Notification, Caption, ScheduledPost, etc. all have onDelete: Cascade)
    await prisma.user.delete({
      where: { id: userId }
    });

    res.status(200).json({
      success: true,
      message: 'Your account and all associated data have been permanently deleted.'
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
};

// Verify Email
const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    const user = await prisma.user.findFirst({
      where: { emailVerificationToken: token }
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null
      }
    });

    res.status(200).json({
      success: true,
      message: 'Email verified successfully. You can now access all features.'
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
};

// Make Admin (protected by secret key from environment — no fallback)
const makeAdmin = async (req, res) => {
  try {
    const { email, secretKey } = req.body;

    // SECURITY: No fallback — server must have ADMIN_SECRET_KEY or this endpoint is unusable
    if (!process.env.ADMIN_SECRET_KEY) {
      console.error('[SECURITY] ADMIN_SECRET_KEY is not configured. makeAdmin endpoint is disabled.');
      return res.status(503).json({ error: 'Admin promotion is not configured on this server' });
    }

    if (secretKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ error: 'Invalid secret key' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Intentionally vague to prevent email enumeration
      return res.status(403).json({ error: 'Invalid secret key or email' });
    }

    await prisma.user.update({
      where: { email },
      data: { role: 'ADMIN' }
    });

    res.status(200).json({
      success: true,
      message: `User ${email} has been promoted to ADMIN. Please log out and log back in.`
    });
  } catch (error) {
    console.error('Make admin error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Google OAuth Sign-In — uses google-auth-library for cryptographic token verification
const googleAuth = async (req, res) => {
  try {
    const { idToken, deviceFingerprint } = req.body;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error('[AUTH] GOOGLE_CLIENT_ID is not configured');
      return res.status(500).json({ error: 'Google Sign-In is not configured on this server' });
    }

    // Cryptographically verify token signature and audience claim
    const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.warn('[AUTH] Google token verification failed:', verifyError.message);
      return res.status(401).json({ error: 'Invalid or expired Google token' });
    }

    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Invalid Google token payload' });
    }

    const email = payload.email.toLowerCase().trim();
    const username = payload.name || email.split('@')[0];
    const profileImage = payload.picture;

    // Check if user exists, otherwise create
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Create new user (generate random password since they use Google)
      const randomPassword = crypto.randomBytes(16).toString('hex') + 'A1!';
      const hashedPassword = await hashPassword(randomPassword);
      const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4);

      user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          username,
          profileImage,
          referralCode,
          ipAddress,
          deviceFingerprint: deviceFingerprint || null,
          // Role defaults to USER — promote via makeAdmin endpoint if needed
          role: 'USER'
        }
      });
    } else {
      // Update login info for existing user
      await prisma.user.update({
        where: { id: user.id },
        data: {
          ipAddress,
          ...(deviceFingerprint && { deviceFingerprint })
        }
      });
    }

    // Generate our JWT with tokenVersion
    const token = generateToken(user.id, user.tokenVersion);

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          profileImage: user.profileImage,
          role: user.role
        },
        token
      }
    });

  } catch (error) {
    console.error('Google Auth error:', error);
    res.status(500).json({ error: 'Google authentication failed', message: 'Internal server error' });
  }
};

// Setup 2FA
const setup2FA = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const secret = speakeasy.generateSecret({ length: 20, name: `CloraAI (${user.email})` });

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret.base32 }
    });

    QRCode.toDataURL(secret.otpauth_url, (err, data_url) => {
      if (err) return res.status(500).json({ error: 'Failed to generate QR code' });
      res.status(200).json({
        success: true,
        secret: secret.base32,
        qrCode: data_url
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Verify 2FA
const verify2FA = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'MFA token is required' });

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || !user.twoFactorSecret) return res.status(400).json({ error: '2FA not setup' });

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token
    });

    if (!verified) {
      return res.status(400).json({ error: 'Invalid 2FA token' });
    }

    if (!user.twoFactorEnabled) {
      // First time verification to enable it
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true }
      });
      return res.status(200).json({ success: true, message: '2FA enabled successfully' });
    }

    // Refresh valid session data
    const accessToken = generateToken(user.id, user.tokenVersion);
    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          profileImage: user.profileImage,
          role: user.role
        },
        token: accessToken
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  register,
  login,
  getCurrentUser,
  updateProfile,
  forgotPassword,
  resetPassword,
  deleteAccount,
  logout,
  makeAdmin,
  googleAuth,
  verifyEmail,
  setup2FA,
  verify2FA
};
