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
let store;

if (redisClient) {
  store = new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  });
  logger.info('AUTH', 'Redis rate-limit store initialized.');
}

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

    req.user = user;
    req.userId = user.id;
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
const rateLimit = (max = 200, windowMinutes = 15, keyGenerator = undefined) => {
  if (process.env.NODE_ENV === 'test') {
    return (req, res, next) => next();
  }

  return expressRateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: store, // Use Redis if available
    keyGenerator: keyGenerator || ((req) => req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'),
    message: {
      error: "Too many requests. Please try again later."
    },
    handler: (req, res, next, options) => {
      logger.warn('RATE_LIMIT', `Rate limit hit`, { ip: req.ip, path: req.path, limit: max });
      res.status(429).json(options.message);
    },
  });
};

const authLimiterLogin = rateLimit(10, 15); // Slightly more relaxed for valid users
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
