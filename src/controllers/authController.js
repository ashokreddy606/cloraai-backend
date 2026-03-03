const { PrismaClient } = require('@prisma/client');
const { generateToken, hashPassword, verifyPassword } = require('../utils/helpers');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const prisma = new PrismaClient();

// Email transporter (Gmail SMTP)
const createTransporter = () => nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});


// User Registration
const register = async (req, res) => {
  try {// Always normalise email — prevents duplicate accounts with different casing
    const email = (req.body.email || '').toLowerCase().trim();
    const { password, username, deviceFingerprint } = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Validation
    if (!email || !password || password.length < 6) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Email and password (min 6 chars) are required'
      });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({
        error: 'User already exists',
        message: 'Email is already registered'
      });
    }

    // Process referral if provided
    let referredById = null;
    if (req.body.referredByCode) {
      const inviter = await prisma.user.findUnique({
        where: { referralCode: req.body.referredByCode }
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
          deviceFingerprint: deviceFingerprint || null
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
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Registration failed',
      message: error.message
    });
  }
};

// User Login
const login = async (req, res) => {
  try {
    // Always normalise email — must match normalised value stored at registration
    const email = (req.body.email || '').toLowerCase().trim();
    const { password, deviceFingerprint } = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Email and password are required'
      });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'User not found'
      });
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.password);

    if (!passwordValid) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Incorrect password'
      });
    }

    // Generate token
    const token = generateToken(user.id);

    // Update login analytics
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ipAddress,
        ...(deviceFingerprint && { deviceFingerprint })
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
      message: error.message
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
      message: error.message,
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

      const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:8081'}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

      // Send email via Gmail SMTP
      if (process.env.SMTP_USER && process.env.SMTP_PASS && !process.env.SMTP_USER.includes('your-gmail')) {
        try {
          const transporter = createTransporter();
          await transporter.sendMail({
            from: process.env.SMTP_FROM || `CloraAI <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Reset Your CloraAI Password',
            html: `
              <!DOCTYPE html>
              <html>
              <head><meta charset="UTF-8"></head>
              <body style="margin:0;padding:0;background:#0B1020;font-family:Arial,sans-serif;">
                <div style="max-width:560px;margin:40px auto;background:#111827;border-radius:20px;overflow:hidden;border:1px solid #1F2937;">
                  <div style="background:linear-gradient(135deg,#6D28D9,#4F46E5);padding:32px;text-align:center;">
                    <h1 style="color:#fff;font-size:28px;margin:0;font-weight:900;">CloraAI ✦</h1>
                  </div>
                  <div style="padding:32px;">
                    <h2 style="color:#FFFFFF;font-size:22px;margin-bottom:12px;">Reset Your Password</h2>
                    <p style="color:#9CA3AF;font-size:15px;line-height:24px;">
                      Hi <strong style="color:#FFFFFF;">${user.username || 'there'}</strong>,<br><br>
                      We received a request to reset the password for your CloraAI account (<strong style="color:#A78BFA;">${email}</strong>).
                    </p>
                    <div style="text-align:center;margin:28px 0;">
                      <a href="${resetLink}" 
                         style="background:linear-gradient(135deg,#6D28D9,#4F46E5);color:#FFFFFF;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700;display:inline-block;">
                        Reset Password →
                      </a>
                    </div>
                    <p style="color:#6B7280;font-size:13px;text-align:center;">
                      This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email.
                    </p>
                  </div>
                  <div style="padding:20px;text-align:center;border-top:1px solid #1F2937;">
                    <p style="color:#4B5563;font-size:12px;margin:0;">© 2026 CloraAI. All rights reserved.</p>
                  </div>
                </div>
              </body>
              </html>
            `,
          });
          console.log(`✅ Password reset email sent to ${email}`);
        } catch (emailErr) {
          console.error('Email send error:', emailErr.message);
        }
      } else {
        console.log(`⚠️  SMTP not configured. Reset link for ${email}:\n${resetLink}`);
      }
    }

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

    if (!token || !newPassword || newPassword.length < 6) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Token and new password (min 6 chars) are required'
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

// Make Admin (protected by secret key from environment)
const makeAdmin = async (req, res) => {
  try {
    const { email, secretKey } = req.body;
    const expectedKey = process.env.ADMIN_SECRET_KEY || 'clora-admin-2026';

    if (secretKey !== expectedKey) {
      return res.status(403).json({ error: 'Invalid secret key' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
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
    res.status(500).json({ error: 'Failed to update role', message: error.message });
  }
};

// Google OAuth Sign-In
const googleAuth = async (req, res) => {
  try {
    const { idToken, deviceFingerprint } = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    // Verify token with Google
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    const payload = await response.json();

    if (payload.error) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    // We can also verify the audience matches our CLIENT_ID here if needed
    // if (payload.aud !== process.env.GOOGLE_CLIENT_ID) { ... }

    const email = payload.email.toLowerCase().trim();
    const username = payload.name || email.split('@')[0];
    const profileImage = payload.picture;

    // Check if user exists, otherwise create
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Create new user (generate random password since they use Google)
      const randomPassword = Math.random().toString(36).slice(-10) + 'A1!'; // satisfying constraints
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
          deviceFingerprint: deviceFingerprint || null
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

    // Generate our JWT
    const token = generateToken(user.id);

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
    res.status(500).json({ error: 'Google authentication failed', message: error.message });
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
  googleAuth
};
