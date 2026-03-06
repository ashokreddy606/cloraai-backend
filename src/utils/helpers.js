const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// ─── JWT_SECRET Strength Validation ──────────────────────────────────────────
// Production systems require a cryptographically strong secret.
// Generate one with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
// Minimum 64 characters enforced. Server refuses to start with a weak secret.
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 64) {
    console.warn('[WARN] JWT_SECRET is missing or too weak. This is insecure for production.');
  }
  return secret;
};

// Tokens expire in 1 day by default. Use JWT_EXPIRY env var to override.
// Shorter expiry limits damage from stolen tokens.
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1d';

// BCRYPT_ROUNDS: 12 is the recommended production minimum (2^12 = 4096 iterations).
// This is 4× slower than 10 but far more resistant to brute-force attacks.
const BCRYPT_ROUNDS = 12;

/**
 * Generate a signed JWT for a user.
 * @param {string} userId
 * @param {number} tokenVersion - incremented on forced logout; embed in token
 */
function generateToken(userId, tokenVersion = 0) {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return jwt.sign(
    { userId, tokenVersion },
    secret,
    { expiresIn: process.env.JWT_EXPIRY || "7d" }
  );
}

function verifyToken(token) {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return jwt.verify(token, secret);
}

/**
 * Hash a password with bcrypt (cost factor 12).
 */
const hashPassword = async (password) => {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
};

const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

const sendResponse = (res, status, data) => {
  res.status(status).json({
    success: status < 400,
    data,
    timestamp: new Date().toISOString()
  });
};

module.exports = {
  generateToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  sendResponse
};
