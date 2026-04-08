const { generateTokens, generateToken, hashPassword, verifyPassword, verifyToken } = require('../utils/helpers');
const Redis = require('ioredis');
const redisClient = require('../lib/redis');
const logger = require('../utils/logger');
const prisma = require('../lib/prisma');
const { getRedirectUrl } = require('../utils/urlUtils');
const { catchAsync, AppError } = require('../utils/errors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { detectDevice, getLocationFromIp, isSuspicious } = require('../utils/sessionUtils');
const dayjs = require('dayjs');
const pushNotificationService = require('../services/pushNotificationService');
const notificationService = require('../services/notificationService');
// Mongoose User model removed — all operations now use Prisma
const transporter = require('../config/mail');
const relativeTime = require('dayjs/plugin/relativeTime');
dayjs.extend(relativeTime);

const sendEmail = async ({ to, subject, html }) => {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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

  // Fallback to Nodemailer transporter from config
  return transporter.sendMail({
    from: process.env.EMAIL_FROM || `"CloraAI" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
};

const register = catchAsync(async (req, res, next) => {
  if (!req || !req.body) throw new AppError('Request body is missing or empty', 400);
  const email = (req.body.email || '').toLowerCase().trim();
  const { password, username, deviceFingerprint, referredByCode, tosAccepted } = req.body;
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

  if (!tosAccepted) throw new AppError('You must accept the Terms of Service to register', 400);
  if (!email || !password || password.length < 8) throw new AppError('Email and password (min 8 chars) are required', 400);

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) throw new AppError('Email is already registered', 409);

  let referredById = null;
  if (referredByCode) {
    const inviter = await prisma.user.findFirst({ where: { referralCode: referredByCode } });
    if (inviter) referredById = inviter.id;
  }

  const hashedPassword = await hashPassword(password);
  const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4);

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
        tosAccepted: true,
        tosAcceptedAt: new Date(),
        isEmailVerified: false,
        emailVerificationToken: crypto.randomBytes(32).toString('hex'),
        role: 'USER'
      }
    });
    if (referredById) {
      await tx.user.update({
        where: { id: referredById },
        data: { totalReferrals: { increment: 1 } }
      });
      
      // Notify the inviter
      if (inviter) {
        await pushNotificationService.notifyReferralSuccess(referredById, username || email.split('@')[0]).catch(err => 
          logger.warn('AUTH:NOTIFY_ERROR', 'Failed to send referral notification', { error: err.message, referrerId: referredById })
        );
      }
    }
    return newUser;
  });

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const { accessToken, refreshToken } = generateTokens(user.id, user.tokenVersion, sessionToken);

  // Create initial session for registration
  const userAgent = req.headers['user-agent'] || '';
  const detectedInfo = detectDevice(userAgent);
  const location = await getLocationFromIp(ipAddress);
  
  await prisma.loginSession.create({
    data: {
      userId: user.id,
      deviceName: detectedInfo.deviceModel || 'Unknown Device',
      deviceType: detectedInfo.deviceType || 'desktop',
      os: detectedInfo.os || 'Unknown',
      browser: detectedInfo.browser || 'Unknown',
      ipAddress,
      city: location.city,
      region: location.region,
      country: location.country,
      timezone: location.timezone,
      sessionToken,
      isCurrent: true,
      loginTime: new Date(),
      lastActive: new Date()
    }
  });

  if (redisClient) await redisClient.set(`refresh_token:${user.id.toString()}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);

  const verifyLink = `${process.env.FRONTEND_URL || 'https://cloraai-backend-production.up.railway.app'}/verify-email?token=${user.emailVerificationToken}`;
  const emailHtml = `<!DOCTYPE html><html><body><h2>Welcome to CloraAI, ${user.username}!</h2><p>Please verify your email address to access all features.</p><a href="${verifyLink}" style="padding:10px 20px; background:#4F46E5; color:white; text-decoration:none; border-radius:5px;">Verify Email</a></body></html>`;

  try {
    await sendEmail({ to: user.email, subject: 'Welcome to CloraAI - Verify Email', html: emailHtml });
  } catch (err) {
    logger.error('AUTH', 'Failed to send verification email', { error: err.message, userId: user.id });
  }

  res.status(201).json({
    success: true,
    data: { user: { id: user.id, email: user.email, username: user.username }, accessToken, refreshToken }
  });
});

const login = async (req, res) => {
  let email = '';
  try {
    email = (req.body.email || '').toLowerCase().trim();
    const { password, deviceFingerprint, deviceName: reqDeviceName, deviceType: reqDeviceType, os: reqOs } = req.body;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || '127.0.0.1';

    if (!email || !password) return res.status(400).json({ error: 'Invalid input', message: 'Email and password are required' });

    const user = await prisma.user.findUnique({ where: { email } });
    const INVALID_CREDS = { error: 'Invalid credentials', message: 'Invalid email or password' };
    const LOCKED_OUT = { error: 'Account locked', message: 'Too many failed login attempts. Please try again after 30 minutes.' };

    if (!user) return res.status(401).json(INVALID_CREDS);
    if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) return res.status(403).json(LOCKED_OUT);

    const passwordValid = await verifyPassword(password, user.password);
    if (!passwordValid) {
      const newAttempts = user.failedLoginAttempts + 1;
      const lockoutUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: newAttempts, lockoutUntil } });
      if (lockoutUntil) return res.status(403).json(LOCKED_OUT);
      return res.status(401).json(INVALID_CREDS);
    }

    if (user.twoFactorEnabled) {
      const tempToken = generateToken(user.id, user.tokenVersion);
      return res.status(200).json({ success: true, requires2FA: true, tempToken, message: 'Two-factor authentication required.' });
    }

    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const { accessToken, refreshToken } = generateTokens(user.id, user.tokenVersion, sessionToken);
    
    // Production Session Management
    const userAgent = req.headers['user-agent'] || '';
    const ipAddress = ip;
    const detectedInfo = detectDevice(userAgent);
    const location = await getLocationFromIp(ipAddress);
    
    // Use requested device info if available (for mobile), fallback to detected info
    const deviceName = reqDeviceName || detectedInfo.deviceModel;
    const deviceType = reqDeviceType || detectedInfo.deviceType;
    const os = reqOs || detectedInfo.os;
    const browser = detectedInfo.browser;

    const expiresAt = deviceType === 'mobile' ? 
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : 
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const latestSession = await prisma.loginSession.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    // Mark previous sessions as NOT current for this user
    await prisma.loginSession.updateMany({
      where: { userId: user.id, isCurrent: true },
      data: { isCurrent: false }
    });

    const currentSessionData = {
      userId: user.id,
      deviceName,
      deviceType,
      os,
      browser,
      ipAddress,
      city: location.city,
      region: location.region,
      country: location.country,
      timezone: location.timezone,
      sessionToken,
      expiresAt,
      isCurrent: true,
      loginTime: new Date(),
      lastActive: new Date()
    };

    if (isSuspicious(latestSession, currentSessionData)) {
      try {
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: 'suspicious_login',
            title: 'New Login Detected',
            body: `New login from ${deviceName} in ${location.city}, ${location.country}. If this wasn't you, please secure your account.`,
            icon: 'shield-alert',
            color: '#EF4444'
          }
        });
      } catch (err) { logger.error('Failed to create suspicious login notification:', err); }
    }

    // Always create a NEW session record
    await prisma.loginSession.create({ data: currentSessionData });

    if (redisClient && process.env.NODE_ENV !== 'test') {
      await redisClient.set(`refresh_token:${user.id.toString()}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);
    }

    if (req.body.fcmToken) {
      await notificationService.registerDevice(user.id, {
        deviceId: req.body.deviceId || 'unknown',
        fcmToken: req.body.fcmToken,
        platform: req.body.platform || 'web'
      }).catch(err => logger.error('AUTH:FCM', 'Failed to register FCM device', { error: err.message }));
    }

    if (req.body.pushToken && pushNotificationService.isLikelyExpoToken(req.body.pushToken)) {
      await prisma.deviceToken.upsert({
        where: { token: req.body.pushToken },
        create: {
          token: req.body.pushToken,
          userId: user.id,
          deviceName,
          deviceType,
          os,
          lastUsed: new Date()
        },
        update: {
          userId: user.id, 
          lastUsed: new Date(),
          deviceName,
          os
        }
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { ipAddress, ...(deviceFingerprint && { deviceFingerprint }), failedLoginAttempts: 0, lockoutUntil: null }
    });

    res.status(200).json({
      success: true,
      data: { user: { id: user.id, email: user.email, username: user.username, profileImage: user.profileImage, role: user.role }, accessToken, refreshToken }
    });
  } catch (error) {
    logger.error('AUTH', 'Login error', { error: error.message, email });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getCurrentUser = async (req, res) => {
  const cacheKey = `user:profile:${req.userId}`;
  
  try {
    // 1. Check Cache first (Ultra-Fast Path)
    if (redisClient && !redisClient.isMock) {
      const cachedData = await redisClient.get(cacheKey);
      if (cachedData) {
        return res.status(200).json({
          success: true,
          data: JSON.parse(cachedData),
          _fromCache: true
        });
      }
    }

    // 2. Database Fetch (Minimal Select for Speed)
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, email: true, username: true, profileImage: true, role: true,
        plan: true, subscriptionStatus: true, planEndDate: true, billingCycle: true,
        instagramAccounts: { where: { isConnected: true }, select: { username: true } }
      }
    });
    
    if (!user) return res.status(404).json({ error: 'User not found' });

    let daysRemaining = null;
    if (user.plan === 'LIFETIME') daysRemaining = null;
    else if (user.planEndDate) {
      const diff = new Date(user.planEndDate) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    // 3. Subscription Auto-Cleanup (Non-blocking background task)
    if (user.plan === 'PRO' && user.planEndDate && new Date(user.planEndDate) < new Date()) {
      prisma.user.update({ 
        where: { id: req.userId }, 
        data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' } 
      }).catch(err => logger.error('AUTH:SUBSCRIPTION_CLEANUP', 'Failed background status update', { error: err.message, userId: req.userId }));
      
      user.plan = 'FREE'; 
      user.subscriptionStatus = 'EXPIRED'; 
      daysRemaining = 0;
    }

    // 4. Lean response for <300ms mobile feel
    const responseData = {
      user: {
        id: user.id, 
        email: user.email, 
        username: user.username, 
        profileImage: user.profileImage, 
        role: user.role,
        plan: user.plan, 
        subscriptionStatus: user.subscriptionStatus, 
        billingCycle: user.billingCycle,
        daysRemaining,
        instagramConnected: user.instagramAccounts.length > 0
      },
    };

    // 5. Set Cache (TTL: 5 minutes)
    if (redisClient && !redisClient.isMock) {
      await redisClient.set(cacheKey, JSON.stringify(responseData), 'EX', 300);
    }

    res.set('Cache-Control', 'private, max-age=60'); // Hint for proxy/client
    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    logger.error('AUTH', 'Get current user error', { error: error.message, userId: req.userId });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { username, phoneNumber, profileImage, bio } = req.body;

    // SECURITY: Validate and check username uniqueness to prevent impersonation
    if (username) {
      // Sanitize: only allow alphanumeric, underscores, 3-30 chars
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({ 
          error: 'Invalid username', 
          message: 'Username must be 3-30 characters and contain only letters, numbers, and underscores' 
        });
      }

      const existingUser = await prisma.user.findFirst({
        where: { username, id: { not: req.userId } }
      });
      if (existingUser) {
        return res.status(409).json({ error: 'Username already taken', message: 'This username is already in use by another account' });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { 
        ...(username && { username }), 
        ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }), 
        ...(profileImage !== undefined && { profileImage: profileImage || null }),
        ...(bio !== undefined && { bio: bio || null })
      }
    });

    // ✅ NEW: Notify user of profile update
    pushNotificationService.notifyAccountAction(req.userId, '👤 Profile Updated', 'Your profile information has been successfully updated.').catch(() => {});

    // Invalidate profile cache
    if (redisClient && !redisClient.isMock) {
      await redisClient.del(`user:profile:${req.userId}`).catch(() => {});
    }

    res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email, username: user.username, profileImage: user.profileImage, phoneNumber: user.phoneNumber, bio: user.bio } } });
  } catch (error) {
    logger.error('AUTH', 'Update profile error', { error: error.message, userId: req.userId });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const logout = async (req, res) => {
  try {
    // Invalidate the specific session token in Redis
    if (req.userId && req.sessionId && redisClient) {
      const session = await prisma.loginSession.findUnique({ where: { id: req.sessionId } });
      if (session?.sessionToken) {
        await redisClient.del(`refresh_token:${req.userId.toString()}:${session.sessionToken}`);
      }
    }
    // Clear specific push token on logout if provided
    if (req.body.deviceId) {
      await notificationService.removeDevice(req.userId, req.body.deviceId).catch(() => {});
    }
    if (req.body.pushToken) {
      await prisma.deviceToken.deleteMany({
        where: { userId: req.userId, token: req.body.pushToken }
      });
    }
    // Also clear from user record for backward compatibility
    if (req.userId) {
      await prisma.user.update({
        where: { id: req.userId },
        data: { pushToken: null }
      });
    }
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(200).json({ success: true, message: 'Logged out' });
  }
};

const refreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken: oldToken } = req.body;
  if (!oldToken) return next(new AppError('Refresh token is required', 400));
  let decoded;
  try { decoded = verifyToken(oldToken); if (decoded.type !== 'refresh') throw new Error('Invalid token type'); } catch (err) { return next(new AppError('Invalid or expired refresh token', 401)); }

  if (redisClient && process.env.NODE_ENV !== 'test') {
    if (!decoded.sessionToken) return next(new AppError('Invalid session. Please login again.', 401));
    
    const redisKey = `refresh_token:${decoded.userId}:${decoded.sessionToken}`;
    const isValid = await redisClient.get(redisKey);
    
    if (!isValid) {
      logger.warn('AUTH:REFRESH', 'Invalid or revoked session attempt', { userId: decoded.userId, sessionToken: decoded.sessionToken });
      return next(new AppError('Session revoked or expired. Please login again.', 401));
    }
    
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, tokenVersion: true } });
    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      await redisClient.del(redisKey);
      return next(new AppError('User not found or session revoked', 401));
    }

    // ── ROTATE: Generate new session token ──────────────────────────────
    const newSessionToken = require('crypto').randomBytes(32).toString('hex');
    
    // Update the record in Prisma
    await prisma.loginSession.updateMany({
      where: { userId: user.id, sessionToken: decoded.sessionToken },
      data: { sessionToken: newSessionToken, lastActive: new Date() }
    });

    // Swap in Redis
    await redisClient.del(redisKey);
    await redisClient.set(`refresh_token:${user.id.toString()}:${newSessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);

    const tokens = generateTokens(user.id, user.tokenVersion, newSessionToken);
    res.status(200).json({ success: true, data: tokens });
  } else {
    // Basic rotation mock for non-redis/test environments
    const newSessionToken = require('crypto').randomBytes(32).toString('hex');
    const tokens = generateTokens(decoded.userId, decoded.tokenVersion, newSessionToken);
    res.status(200).json({ success: true, data: tokens });
  }
});

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    
    // For security, don't reveal if user exists
    if (!user) {
      return res.status(200).json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: token,
        resetPasswordExpires: resetExpires,
      },
    });

    const resetUrl = `${process.env.BASE_URL}/reset-password/${token}`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #4F46E5; text-align: center;">CloraAI</h2>
        <h3 style="color: #333; text-align: center;">Password Reset Request</h3>
        <p style="color: #666; font-size: 16px; line-height: 1.5;">
          You requested a password reset for your CloraAI account. Click the button below to reset it:
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Reset Password</a>
        </div>
        <p style="color: #666; font-size: 14px;">
          This link will expire in 10 minutes. 
        </p>
        <p style="color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px;">
          If you did not request this, please ignore this email.
        </p>
      </div>
    `;

    await sendEmail({
      to: email,
      subject: 'Password Reset Request - CloraAI',
      html: emailHtml
    });

    res.status(200).json({ success: true, message: 'Reset link sent to your email.' });
  } catch (error) {
    logger.error('AUTH', 'Forgot password error', { error: error.message, email: req.body?.email });
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: { gt: new Date() }
      }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    // Hash new password and clear reset fields atomically
    const hashedPassword = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    res.status(200).json({ success: true, message: 'Password reset successful. You can now login.' });
  } catch (error) {
    logger.error('AUTH', 'Reset password error:', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const { secureDeleteAccount } = require('../services/userService');
    await secureDeleteAccount(req.userId);
    res.status(200).json({ success: true, message: 'Account and associated data have been permanently deleted.' });
  } catch (error) { 
    logger.error('AUTH', 'Delete account error', { error: error.message, userId: req.userId });
    res.status(500).json({ error: 'Failed to delete account securely' }); 
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    const user = await prisma.user.findFirst({ where: { emailVerificationToken: token } });
    if (!user) return res.status(400).json({ error: 'Invalid token' });
    await prisma.user.update({ where: { id: user.id }, data: { isEmailVerified: true, emailVerificationToken: null } });
    res.status(200).json({ success: true, message: 'Email verified.' });
  } catch (error) { 
    logger.error('AUTH', 'Verify email error', { error: error.message });
    res.status(500).json({ error: 'Internal Server Error' }); 
  }
};

const makeAdmin = async (req, res) => {
  try {
    const { email, secretKey } = req.body;
    if (secretKey !== process.env.ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
    await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
    res.status(200).json({ success: true, message: 'User promoted.' });
  } catch (error) { 
    logger.error('AUTH', 'Make admin error', { error: error.message, email: req.body?.email });
    res.status(500).json({ error: 'Internal Server Error' }); 
  }
};

const googleAuth = async (req, res) => {
  try {
    const { idToken, deviceName: reqDeviceName, deviceType: reqDeviceType, os: reqOs } = req.body;
    const ipAddress = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || '127.0.0.1';
    
    if (!idToken) return res.status(400).json({ error: 'idToken required' });
    const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase().trim();
    
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const hashedPassword = await hashPassword(require('crypto').randomBytes(16).toString('hex') + 'A1!');
      user = await prisma.user.create({ 
        data: { 
          email, 
          password: hashedPassword, 
          username: payload.name || email.split('@')[0], 
          profileImage: payload.picture, 
          referralCode: Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4), 
          ipAddress, 
          role: 'USER' 
        } 
      });
    }

    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const { accessToken, refreshToken } = generateTokens(user.id, user.tokenVersion, sessionToken);
    
    const userAgent = req.headers['user-agent'] || '';
    const detectedInfo = detectDevice(userAgent);
    const location = await getLocationFromIp(ipAddress);
    
    const deviceName = reqDeviceName || detectedInfo.deviceModel;
    const deviceType = reqDeviceType || detectedInfo.deviceType;
    const os = reqOs || detectedInfo.os;
    const browser = detectedInfo.browser;

    const expiresAt = deviceType === 'mobile' ? 
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : 
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const latestSession = await prisma.loginSession.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    // Mark previous sessions as NOT current for this user
    await prisma.loginSession.updateMany({
      where: { userId: user.id, isCurrent: true },
      data: { isCurrent: false }
    });

    const currentSessionData = {
      userId: user.id,
      deviceName,
      deviceType,
      os,
      browser,
      ipAddress,
      city: location.city,
      region: location.region,
      country: location.country,
      timezone: location.timezone,
      sessionToken,
      expiresAt,
      isCurrent: true,
      loginTime: new Date(),
      lastActive: new Date()
    };

    if (isSuspicious(latestSession, currentSessionData)) {
      try {
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: 'suspicious_login',
            title: 'New Login Detected',
            body: `New login from ${deviceName} in ${location.city}, ${location.country}. If this wasn't you, please secure your account.`,
            icon: 'shield-alert',
            color: '#EF4444'
          }
        });
      } catch (err) { logger.error('Failed to create suspicious login notification:', err); }
    }

    await prisma.loginSession.create({ data: currentSessionData });

    if (redisClient && process.env.NODE_ENV !== 'test') {
      await redisClient.set(`refresh_token:${user.id.toString()}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);
    }
    res.status(200).json({ 
      success: true, 
      data: { 
        user: { id: user.id, email: user.email, username: user.username, profileImage: user.profileImage, role: user.role }, 
        accessToken, 
        refreshToken 
      } 
    });
  } catch (error) { 
    logger.error('AUTH', 'Google Auth error', { error: error.message });
    res.status(500).json({ error: 'Internal Server Error' }); 
  }
};

const setup2FA = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const secret = speakeasy.generateSecret({ length: 20, name: `CloraAI (${user.email})` });
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret.base32 } });
    QRCode.toDataURL(secret.otpauth_url, (err, data_url) => { res.status(200).json({ success: true, secret: secret.base32, qrCode: data_url }); });
  } catch (err) { 
    logger.error('AUTH', '2FA setup error', { error: err.message, userId: req.userId });
    res.status(500).json({ error: 'Internal Server Error' }); 
  }
};

const verify2FA = async (req, res) => {
  try {
    const { token, deviceName: reqDeviceName, deviceType: reqDeviceType, os: reqOs } = req.body;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || '127.0.0.1';
    
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const verified = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token });
    if (!verified) return res.status(400).json({ error: 'Invalid token' });
    
    if (!user.twoFactorEnabled) await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    
    // Production Session Management
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const { accessToken, refreshToken } = generateTokens(user.id, user.tokenVersion, sessionToken);
    
    const userAgent = req.headers['user-agent'] || '';
    const detectedInfo = detectDevice(userAgent);
    const location = await getLocationFromIp(ip);
    
    const deviceName = reqDeviceName || detectedInfo.deviceModel;
    const deviceType = reqDeviceType || detectedInfo.deviceType;
    const os = reqOs || detectedInfo.os;
    const browser = detectedInfo.browser;

    const expiresAt = deviceType === 'mobile' ? 
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : 
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Mark previous current session as false
    await prisma.loginSession.updateMany({
      where: { userId: user.id, isCurrent: true },
      data: { isCurrent: false }
    });

    await prisma.loginSession.create({
      data: {
        userId: user.id,
        deviceName,
        deviceType,
        os,
        browser,
        ipAddress: ip,
        city: location.city,
        region: location.region,
        country: location.country,
        timezone: location.timezone,
        sessionToken,
        isCurrent: true,
        loginTime: new Date(),
        lastActive: new Date(),
        expiresAt
      }
    });

    if (redisClient && process.env.NODE_ENV !== 'test') {
      await redisClient.set(`refresh_token:${user.id.toString()}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);
    }

    res.status(200).json({ 
      success: true, 
      data: { 
        user: { id: user.id, email: user.email, username: user.username, profileImage: user.profileImage, role: user.role }, 
        accessToken, 
        refreshToken 
      } 
    });
  } catch (err) { 
    logger.error('AUTH', '2FA verification error', { error: err.message, userId: req.userId });
    res.status(500).json({ error: 'Internal Server Error' }); 
  }
};

const getSessions = catchAsync(async (req, res, next) => {
  const sessions = await prisma.loginSession.findMany({ 
    where: { userId: req.userId }, 
    orderBy: { lastActive: 'desc' } 
  });
  
  // Filtering out expired sessions if they have an expiration date
  const activeSessions = sessions.filter(s => !s.expiresAt || new Date(s.expiresAt) > new Date());
  
  // identify the device that made the current request
  // Use toString() to ensure comparison works regardless of type (ObjectId vs String)
  const current = activeSessions.find(s => s.id.toString() === req.sessionId?.toString()) || activeSessions[0];
  const other = activeSessions.filter(s => s.id.toString() !== current?.id?.toString());

  const formatSession = (s, isCurrentReq) => ({
    sessionId: s.id,
    device: s.deviceName || 'Unknown Device',
    os: s.os || 'Unknown',
    browser: s.browser || 'Unknown',
    location: (s.city && s.country) ? `${s.city}, ${s.country}` : 'Unknown Location',
    ip: s.ipAddress || 'Unknown',
    active: isCurrentReq ? 'Active now' : s.lastActive ? dayjs(s.lastActive).fromNow() : 'Recently active',
    currentDevice: isCurrentReq
  });

  res.status(200).json({ 
    success: true, 
    data: {
      currentDevice: current ? formatSession(current, true) : null,
      otherDevices: other.map(s => formatSession(s, false))
    }
  });
});

const logoutSession = catchAsync(async (req, res, next) => {
  const { sessionId, password } = req.body;
  if (!sessionId) throw new AppError('Session ID is required', 400);
  if (!password) throw new AppError('Password is required for this action', 400);

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, password: true, failedLogoutAttempts: true, logoutLockoutUntil: true }
  });

  if (!user) throw new AppError('User not found', 404);

  // Check lockout
  if (user.logoutLockoutUntil && new Date(user.logoutLockoutUntil) > new Date()) {
    throw new AppError('please try again after 24 hours', 403);
  }

  // Verify password
  const isPasswordValid = await verifyPassword(password, user.password);
  if (!isPasswordValid) {
    const newAttempts = user.failedLogoutAttempts + 1;
    let logoutLockoutUntil = user.logoutLockoutUntil;
    
    if (newAttempts >= 5) {
      logoutLockoutUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogoutAttempts: newAttempts, logoutLockoutUntil }
    });

    if (newAttempts >= 5) {
      throw new AppError('please try again after 24 hours', 403);
    }
    throw new AppError('wrong password please enter correct password', 401);
  }

  // Reset failed attempts on success
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogoutAttempts: 0, logoutLockoutUntil: null, pushToken: null }
  });

  // Clear specific push token if provided
  if (req.body.pushToken) {
    await prisma.deviceToken.deleteMany({
      where: { userId: user.id, token: req.body.pushToken }
    });
  }

  const session = await prisma.loginSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId.toString() !== req.userId.toString()) throw new AppError('Session not found', 404);

  if (session.sessionToken && redisClient) {
    await redisClient.del(`refresh_token:${req.userId.toString()}:${session.sessionToken}`);
  }

  await prisma.loginSession.delete({ where: { id: sessionId } });
  
  // Clear push token as well when a specific session is logged out
  if (req.body.pushToken) {
    await prisma.deviceToken.deleteMany({
       where: { userId: req.userId, token: req.body.pushToken }
    });
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: { pushToken: null }
  });

  res.status(200).json({ success: true, message: 'Logged out from device.' });
});

const logoutAllDevices = catchAsync(async (req, res, next) => {
  const { password } = req.body;
  if (!password) throw new AppError('Password is required for this action', 400);

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, password: true, failedLogoutAttempts: true, logoutLockoutUntil: true }
  });

  if (!user) throw new AppError('User not found', 404);

  // Check lockout
  if (user.logoutLockoutUntil && new Date(user.logoutLockoutUntil) > new Date()) {
    throw new AppError('please try again after 24 hours', 403);
  }

  // Verify password
  const isPasswordValid = await verifyPassword(password, user.password);
  if (!isPasswordValid) {
    const newAttempts = user.failedLogoutAttempts + 1;
    let logoutLockoutUntil = user.logoutLockoutUntil;
    
    if (newAttempts >= 5) {
      logoutLockoutUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogoutAttempts: newAttempts, logoutLockoutUntil }
    });

    if (newAttempts >= 5) {
      throw new AppError('please try again after 24 hours', 403);
    }
    throw new AppError('wrong password please enter correct password', 401);
  }

  // Reset failed attempts on success
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogoutAttempts: 0, logoutLockoutUntil: null }
  });

  const sessions = await prisma.loginSession.findMany({ 
    where: { 
      userId: req.userId,
      id: { not: req.sessionId }
    }
  });

  // Invalidate all refresh tokens in Redis
  if (redisClient) {
    for (const session of sessions) {
      if (session.sessionToken) {
        await redisClient.del(`refresh_token:${session.userId.toString()}:${session.sessionToken}`);
      }
    }
  }

  await prisma.loginSession.deleteMany({ 
    where: { 
      userId: req.userId,
      id: { not: req.sessionId }
    } 
  });

  res.status(200).json({ success: true, message: 'Logged out from all other devices.' });
});

const facebookCallback = (req, res) => res.redirect(getRedirectUrl('instagram-success', { code: req.query.code }));
const instagramCallback = (req, res) => res.redirect(getRedirectUrl('instagram-success', { code: req.query.code }));

module.exports = {
  register, login, getCurrentUser, updateProfile, forgotPassword, resetPassword, deleteAccount, logout, makeAdmin, googleAuth, verifyEmail, setup2FA, verify2FA, facebookCallback, instagramCallback, refreshToken, getSessions, logoutSession, logoutAllDevices
};
