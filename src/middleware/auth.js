/**
 * middleware/auth.js
 * Authentication, authorisation, and rate-limiting middleware for CloraAI.
 *
 * Security notes:
 *  - authenticate validates JWT signature AND tokenVersion (enables forced logout).
 *  - SUSPENDED / BANNED roles are blocked at the gate before any business logic.
 *  - Rate limiting uses express-rate-limit (production-grade, trust-proxy aware).
 */

const { verifyToken } = require('../utils/helpers');
const prisma = require('../lib/prisma');
const { rateLimit: expressRateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const logger = require('../utils/logger');

// ─── Redis Setup for Rate Limiting ───────────────────────────────────────────
const redisClient = require('../lib/redis');
// We no longer create a single global store because express-rate-limit 7.x
// requires a unique store instance per rate limiter to prevent state leak.

// ... 1. Authentication Middleware ...
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, tokenVersion: true }
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (user.role === 'SUSPENDED' || user.role === 'BANNED') {
      return res.status(403).json({ error: `Your account has been ${user.role.toLowerCase()}. Please contact support.` });
    }

    if (decoded.tokenVersion !== undefined && user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ error: "Session expired. Please login again." });
    }

    // --- Session Persistence Check ---
    // Fast-path: Check Redis first for instant invalidation
    if (redisClient && decoded.sessionToken) {
      const redisKey = `refresh_token:${user.id.toString()}:${decoded.sessionToken}`;
      const isRedisValid = await redisClient.get(redisKey);
      if (!isRedisValid) {
        return res.status(401).json({ error: "Session revoked or expired. Please log in again." });
      }
    }

    // Secondary-path: Database check for persistence/expiration
    const currentSession = await prisma.loginSession.findFirst({
      where: {
        userId: user.id,
        sessionToken: decoded.sessionToken,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
        ]
      }
    });

    if (!currentSession) {
      if (!decoded.sessionToken) {
        return res.status(401).json({ error: "Session tracking upgrade. Please log in again to secure your account." });
      }
      return res.status(401).json({ error: "Session invalidated or expired. Please log in again." });
    }

    // Update lastActive (Throttle to once every 5 minutes to save DB writes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (currentSession.lastActive < fiveMinutesAgo) {
      await prisma.loginSession.update({
        where: { id: currentSession.id },
        data: { lastActive: new Date() }
      });
    }

    req.user = user;
    req.userId = user.id;
    req.sessionId = currentSession.id;
    next();
  } catch (err) {
    console.error("Authentication middleware error:", err);
    res.status(500).json({ error: "Authentication error" });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return res.status(403).json({ error: 'Forbidden: Admin access only' });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Authorization error' });
  }
};

/**
 * Rate Limiter Factory
 * Uses RedisStore in production to prevent IP bypass across scaled instances.
 */
const rateLimit = (max = 500, windowMinutes = 15, keyGenerator = undefined) => {
  if (process.env.NODE_ENV === 'test') {
    return (req, res, next) => next();
  }

  const store = redisClient ? new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: `rl:${keyGenerator ? 'custom' : 'ip'}:${windowMinutes}m:`,
  }) : undefined;

  return expressRateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store, // Each limiter now gets its own store instance
    keyGenerator: keyGenerator || ((req) => {
      // Prioritize standard headers from trusted proxies (Railway/Cloudflare/AWS)
      return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
             req.headers['x-real-ip'] || 
             req.ip || 
             '127.0.0.1';
    }),
    message: {
      error: "Too many requests. Please try again later."
    },
    handler: (req, res, next, options) => {
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
      logger.warn('RATE_LIMIT', `Rate limit hit`, { ip: clientIp, path: req.path, limit: max });
      res.status(429).json(options.message);
    },
  });
};

const authLimiterLogin = rateLimit(100, 15); // INCREASED: 100 attempts/15min to prevent false positives in shared network environments
const authLimiterRegister = rateLimit(5, 60); // Stricter for registration
const authLimiterForgot = rateLimit(5, 60);

module.exports = {
  authenticate,
  requireAdmin,
  rateLimit,
  authLimiterLogin,
  authLimiterRegister,
  authLimiterForgot
};
