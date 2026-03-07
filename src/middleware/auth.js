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
const expressRateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');

// ─── 1. Authentication Middleware ─────────────────────────────────────────────
/**
 * Validates Bearer JWT, then does a lightweight DB lookup to:
 *   a) Confirm the tokenVersion matches (catches force-logout via admin)
 *   b) Block SUSPENDED or BANNED accounts immediately with 403
 *
 * Attaches req.userId for downstream use.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.error("[AUTH] 401 - No token provided or wrong format:", authHeader);
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      console.error("[AUTH] 401 - Invalid token:", err.message);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // ── Fix #2: Validate tokenVersion and user role ──
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, tokenVersion: true }
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Check for suspended or banned users
    if (user.role === 'SUSPENDED' || user.role === 'BANNED') {
      console.warn(`[AUTH] 403 - Blocked access for ${user.role} user:`, user.id);
      return res.status(403).json({ error: `Your account has been ${user.role.toLowerCase()}. Please contact support.` });
    }

    // Check token version (enables forced logout/password change invalidation)
    if (decoded.tokenVersion !== undefined && user.tokenVersion !== decoded.tokenVersion) {
      console.warn("[AUTH] 401 - Token version mismatch. Forced logout required.");
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

// ─── 2. Admin Authorisation Middleware ────────────────────────────────────────
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

// ─── 3. Global Rate Limiter (express-rate-limit) ──────────────────────────────
// Replaces the custom in-memory implementation which had no trust-proxy support
// (req.ip returned the proxy IP instead of the real client IP behind Nginx/AWS).
//
// IMPORTANT: app.set('trust proxy', 1) must be called in server.js BEFORE this
// middleware is applied. Without it, all requests share the same proxy IP and
// the limiter will not work correctly.
//
// windowMs: 15 minutes | max: 200 requests per window per real client IP
// Global rate limiter (200 requests per 15 minutes per IP)
const limiter = (process.env.NODE_ENV === 'test')
  ? (req, res, next) => next()
  : expressRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
  });

/**
 * Rate Limiter Factory
 * Production-ready wrapper for express-rate-limit.
 */
const rateLimit = (max = 200, windowMinutes = 15, keyGenerator = undefined) => {
  // Bypass rate limiting in test environment to avoid library/supertest conflicts
  if (process.env.NODE_ENV === 'test') {
    return (req, res, next) => next();
  }

  return expressRateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyGenerator || ((req) => req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'),
    message: {
      error: 'Too many requests',
      message: `Rate limit exceeded. Please wait ${windowMinutes} minutes.`,
    },
    handler: (req, res, next, options) => {
      logger.warn('RATE_LIMIT', `Rate limit hit`, { ip: req.ip, path: req.path, limit: max });
      res.status(429).json(options.message);
    },
  });
};

const authLimiterLogin = rateLimit(5, 15);
const authLimiterRegister = rateLimit(3, 15);
const authLimiterForgot = rateLimit(3, 15);

module.exports = {
  authenticate,
  requireAdmin,
  rateLimit,
  limiter,
  authLimiterLogin,
  authLimiterRegister,
  authLimiterForgot
};
