const { generateTokens, generateToken, hashPassword, verifyPassword, verifyToken } = require('../utils/helpers');
const Redis = require('ioredis');
const redisClient = require('../lib/redis');
const logger = require('../utils/logger');
const prisma = require('../lib/prisma');
const { catchAsync, AppError } = require('../utils/errors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { detectDevice, getLocationFromIp, isSuspicious } = require('../utils/sessionUtils');
const dayjs = require('dayjs');
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
  throw new Error('No email provider configured. Set RESEND_API_KEY or SMTP_USER+SMTP_PASS on Railway.');
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

  if (redisClient) await redisClient.set(`refresh_token:${user.id}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);

  const verifyLink = `${process.env.FRONTEND_URL || 'https://cloraai-backend-production.up.railway.app'}/verify-email?token=${user.emailVerificationToken}`;
  const emailHtml = `<!DOCTYPE html><html><body><h2>Welcome to CloraAI, ${user.username}!</h2><p>Please verify your email address to access all features.</p><a href="${verifyLink}" style="padding:10px 20px; background:#4F46E5; color:white; text-decoration:none; border-radius:5px;">Verify Email</a></body></html>`;

  try {
    await sendEmail({ to: user.email, subject: 'Welcome to CloraAI - Verify Email', html: emailHtml });
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
  }

  res.status(201).json({
    success: true,
    data: { user: { id: user.id, email: user.email, username: user.username }, accessToken, refreshToken }
  });
});

const login = async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
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
      await redisClient.set(`refresh_token:${user.id}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);
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
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', message: 'Internal server error' });
  }
};

const getCurrentUser = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { instagramAccounts: { select: { username: true, isConnected: true } } },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let daysRemaining = null;
    if (user.plan === 'LIFETIME') daysRemaining = null;
    else if (user.planEndDate) {
      const diff = new Date(user.planEndDate) - new Date();
      daysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    }

    if (user.plan === 'PRO' && user.subscriptionStatus === 'ACTIVE' && user.planEndDate && new Date(user.planEndDate) < new Date()) {
      await prisma.user.update({ where: { id: req.userId }, data: { plan: 'FREE', subscriptionStatus: 'EXPIRED' } });
      user.plan = 'FREE'; user.subscriptionStatus = 'EXPIRED'; daysRemaining = 0;
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id, email: user.email, username: user.username, profileImage: user.profileImage, role: user.role,
          phoneNumber: user.phoneNumber, instagramConnected: user.instagramAccounts?.some(a => a.isConnected) ?? false,
          plan: user.plan, subscriptionStatus: user.subscriptionStatus, planSource: user.planSource,
          planStartDate: user.planStartDate, planEndDate: user.planEndDate, daysRemaining, manuallyUpgraded: user.manuallyUpgraded,
        },
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user', message: 'Internal server error' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { username, phoneNumber, profileImage } = req.body;
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { ...(username && { username }), ...(phoneNumber !== undefined && { phoneNumber: phoneNumber || null }), ...(profileImage !== undefined && { profileImage: profileImage || null }) }
    });
    res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email, username: user.username, profileImage: user.profileImage, phoneNumber: user.phoneNumber } } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update profile', message: error.message });
  }
};

const logout = async (req, res) => {
  try {
    // Invalidate the specific session token in Redis
    if (req.userId && req.sessionId && redisClient) {
      const session = await prisma.loginSession.findUnique({ where: { id: req.sessionId } });
      if (session?.sessionToken) {
        await redisClient.del(`refresh_token:${req.userId}:${session.sessionToken}`);
      }
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
      return next(new AppError('Session revoked or expired. Please login again.', 401));
    }
    
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, tokenVersion: true } });
    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      await redisClient.del(`refresh_token:${decoded.userId}:${oldToken}`);
      return next(new AppError('User not found or session revoked', 401));
    }
    const tokens = generateTokens(user.id, user.tokenVersion, decoded.sessionToken);
    // Refresh the same key (idempotent sliding window)
    await redisClient.set(redisKey, 'valid', 'EX', 7 * 24 * 60 * 60);
    res.status(200).json({ success: true, data: tokens });
  } else {
    const tokens = generateTokens(decoded.userId, decoded.tokenVersion);
    res.status(200).json({ success: true, data: tokens });
  }
});

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await prisma.passwordReset.updateMany({ where: { userId: user.id, used: false }, data: { used: true } });
      await prisma.passwordReset.create({ data: { userId: user.id, token: resetToken, expiresAt } });
      const resetLink = `${process.env.FRONTEND_URL || 'https://cloraai-backend-production.up.railway.app'}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
      const emailHtml = `<!DOCTYPE html><html><body style="background:#0B1020;padding:20px;"><div style="background:#111827;padding:30px;border-radius:10px;color:#fff;"><h2>Reset Password</h2><a href="${resetLink}" style="color:#A78BFA;">Reset Password &rarr;</a></div></body></html>`;
      try { await sendEmail({ to: email, subject: 'Reset Password', html: emailHtml }); } catch (err) { console.error('Email failed:', err.message); }
    }
    res.status(200).json({ success: true, message: 'Reset link sent if account exists.' });
  } catch (error) { res.status(500).json({ error: 'Failed to process request' }); }
};

const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Invalid input' });
    const resetRecord = await prisma.passwordReset.findUnique({ where: { token } });
    if (!resetRecord || resetRecord.used || resetRecord.expiresAt < new Date()) return res.status(400).json({ error: 'Expired token' });
    const hashedPassword = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: resetRecord.userId }, data: { password: hashedPassword } });
    await prisma.passwordReset.update({ where: { id: resetRecord.id }, data: { used: true } });
    res.status(200).json({ success: true, message: 'Password reset successful.' });
  } catch (error) { res.status(500).json({ error: 'Failed to reset password' }); }
};

const deleteAccount = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { scheduledPosts: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await prisma.user.delete({ where: { id: userId } });
    res.status(200).json({ success: true, message: 'Account deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete' }); }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    const user = await prisma.user.findFirst({ where: { emailVerificationToken: token } });
    if (!user) return res.status(400).json({ error: 'Invalid token' });
    await prisma.user.update({ where: { id: user.id }, data: { isEmailVerified: true, emailVerificationToken: null } });
    res.status(200).json({ success: true, message: 'Email verified.' });
  } catch (error) { res.status(500).json({ error: 'Verification failed' }); }
};

const makeAdmin = async (req, res) => {
  try {
    const { email, secretKey } = req.body;
    if (secretKey !== process.env.ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
    await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
    res.status(200).json({ success: true, message: 'User promoted.' });
  } catch (error) { res.status(500).json({ error: 'Internal error' }); }
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
      await redisClient.set(`refresh_token:${user.id}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);
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
    console.error('Google Auth error:', error);
    res.status(500).json({ error: 'Google auth failed' }); 
  }
};

const setup2FA = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const secret = speakeasy.generateSecret({ length: 20, name: `CloraAI (${user.email})` });
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret.base32 } });
    QRCode.toDataURL(secret.otpauth_url, (err, data_url) => { res.status(200).json({ success: true, secret: secret.base32, qrCode: data_url }); });
  } catch (err) { res.status(500).json({ error: '2FA setup failed' }); }
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
      await redisClient.set(`refresh_token:${user.id}:${sessionToken}`, 'valid', 'EX', 7 * 24 * 60 * 60);
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
    console.error('2FA verification failed:', err);
    res.status(500).json({ error: '2FA verification failed' }); 
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
  const { sessionId } = req.body;
  if (!sessionId) throw new AppError('Session ID is required', 400);

  const session = await prisma.loginSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId.toString() !== req.userId.toString()) throw new AppError('Session not found', 404);

  if (session.sessionToken && redisClient) {
    await redisClient.del(`refresh_token:${req.userId}:${session.sessionToken}`);
  }

  await prisma.loginSession.delete({ where: { id: sessionId } });
  res.status(200).json({ success: true, message: 'Logged out from device.' });
});

const logoutAllDevices = catchAsync(async (req, res, next) => {
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

const facebookCallback = (req, res) => res.redirect('cloraai://instagram-success?code=' + req.query.code);
const instagramAuth = (req, res) => res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.INSTAGRAM_APP_ID}&redirect_uri=${encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI)}&scope=instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement&response_type=code`);
const instagramCallback = (req, res) => res.redirect('cloraai://instagram-success?code=' + req.query.code);

module.exports = {
  register, login, getCurrentUser, updateProfile, forgotPassword, resetPassword, deleteAccount, logout, makeAdmin, googleAuth, verifyEmail, setup2FA, verify2FA, facebookCallback, instagramAuth, instagramCallback, refreshToken, getSessions, logoutSession, logoutAllDevices
};
