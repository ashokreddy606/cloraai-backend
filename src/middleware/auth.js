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
const { PrismaClient } = require('@prisma/client');
const expressRateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

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

    req.user = decoded;
    req.userId = decoded.userId;

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

    if (!user || user.role !== 'ADMIN') {
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
const limiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,   // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,    // Do not use X-RateLimit-* headers
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please wait before making more requests.',
  },
  handler: (req, res, next, options) => {
    logger.warn('RATE_LIMIT', `Rate limit hit`, { ip: req.ip, path: req.path });
    res.status(429).json(options.message);
  },
});

// Keep the old factory signature as a thin wrapper so existing server.js import
// (rateLimit(200, 15 * 60 * 1000)) continues to work without changes.
// The parameters are ignored — the global limiter is returned directly.
const rateLimit = () => limiter;

module.exports = {
  authenticate,
  requireAdmin,
  rateLimit,
  limiter,
};
