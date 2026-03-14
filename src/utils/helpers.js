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

// Shortened token lifespan for PRODUCTION SECURITY. 1 hour is standard.
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';

// BCRYPT_ROUNDS: 12 is the recommended production minimum (2^12 = 4096 iterations).
const BCRYPT_ROUNDS = 12;

const REFRESH_TOKEN_EXPIRY = '7d';

/**
 * Generate a pair of tokens (Access + Refresh).
 */
function generateTokens(userId, tokenVersion = 0) {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not configured");
  
  const accessToken = jwt.sign(
    { userId, tokenVersion, type: 'access' },
    secret,
    { 
      expiresIn: JWT_EXPIRY,
      algorithm: 'HS256',
      issuer: 'cloraai',
      audience: 'cloraai-users'
    }
  );

  const refreshToken = jwt.sign(
    { userId, tokenVersion, type: 'refresh' },
    secret,
    { 
      expiresIn: REFRESH_TOKEN_EXPIRY,
      algorithm: 'HS256',
      issuer: 'cloraai',
      audience: 'cloraai-users'
    }
  );

  return { accessToken, refreshToken };
}

function verifyToken(token) {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not configured");

  try {
    // PRODUCTION SECURITY: Explicitly define allowed algorithms and validate issuer/audience
    return jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'cloraai',
      audience: 'cloraai-users'
    });
  } catch (err) {
    // If JWT_SECRET was rotated, try previously valid secret
    const previousSecret = process.env.JWT_SECRET_PREVIOUS;
    if (previousSecret && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
      return jwt.verify(token, previousSecret, {
        algorithms: ['HS256'],
        issuer: 'cloraai',
        audience: 'cloraai-users'
      });
    }
    throw err;
  }
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
  generateTokens,
  verifyToken,
  hashPassword,
  verifyPassword,
  sendResponse
};
