// redeploy trigger
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { rateLimit } = require('./middleware/auth');
const logger = require('./utils/logger');

// ─── Optional Sentry Error Tracking ──────────────────────────────────────────
// Activate by setting SENTRY_DSN in environment. No impact if unset.
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
  logger.info('SERVER', 'Sentry error tracking initialized.');
}

// ─── Process-Level Error Catchers ────────────────────────────────────────────
// These are last-resort handlers for bugs that escape all try/catch blocks.
process.on('uncaughtException', (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on('unhandledRejection', (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

// Import routes
const authRoutes = require('./routes/auth');
const instagramRoutes = require('./routes/instagram');
const analyticsRoutes = require('./routes/analytics');
const captionRoutes = require('./routes/caption');
const subscriptionRoutes = require('./routes/subscription');
const schedulerRoutes = require('./routes/scheduler');
const dmAutomationRoutes = require('./routes/dmAutomation');
const brandDealRoutes = require('./routes/brandDeal');
const referralRoutes = require('./routes/referral');
const adminRoutes = require('./routes/admin');
const calendarRoutes = require('./routes/calendar');
const notificationRoutes = require('./routes/notification');
const webhookRoutes = require('./routes/webhook');

// Initialize Prisma
const prisma = new PrismaClient();

// Initialize Cron Jobs
const { schedulerTasks, releaseLock } = require('./services/schedulerCron');
try {
  require('./services/subscriptionCron');
  console.log("Subscription cron started successfully");
} catch (err) {
  console.error("Subscription cron failed:", err);
}

// Initialize Express app
const app = express();

// Security: Crash immediately if critical keys are missing
const requiredEnvs = [
  'JWT_SECRET',
  'DATABASE_URL',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'INSTAGRAM_APP_SECRET',
];
const missingEnvs = requiredEnvs.filter(env => !process.env[env]);
if (missingEnvs.length > 0) {
  logger.error('SERVER', `Missing critical environment variables: ${missingEnvs.join(', ')}. Shutting down.`);
  process.exit(1);
}

// JWT_SECRET minimum strength check (must be ≥ 64 characters).
// helpers.js also enforces this, but belt-and-suspenders catch at server entry.
if (process.env.JWT_SECRET.length < 64) {
  logger.error('SERVER', 'JWT_SECRET is too weak (must be ≥ 64 characters). Generate with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// Raw body capture for Razorpay webhook signature verification
// MUST be registered BEFORE express.json() for this specific path
app.use('/api/webhook/razorpay', express.raw({ type: 'application/json' }));

// Raw body capture for Instagram webhook signature verification (X-Hub-Signature-256)
// Uses express.json() with a verify callback to attach rawBody to req before JSON parsing.
app.use('/api/webhook/instagram', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // Buffer — used by verifyInstagramSignature()
  }
}));


// Trust the first proxy (Nginx / AWS ALB / Cloud Run) so express-rate-limit
// and IP-based logic see the real client IP from X-Forwarded-For, not the proxy.
// IMPORTANT: Only set to 1 (single trusted proxy). Set to the actual number of
// proxies in front of your app in production if stacked.
app.set('trust proxy', 1);

// Security middleware — Helmet sets secure HTTP headers.
// CSP configured for an API-only backend: no frames, no scripts, API only.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],   // Prevent clickjacking
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: {
    maxAge: 31536000,              // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

// CORS — restrict in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : false)
    : '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global rate limiting (200 requests per 15 minutes per IP)
app.use(rateLimit(200, 15 * 60 * 1000));

// Request logging middleware (safe — no body logging)
app.use((req, res, next) => {
  logger.debug('HTTP', `${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// Internal monitoring metrics endpoint
// Secured by X-Internal-Token header. INTERNAL_METRICS_TOKEN must be set in .env.
// If the env var is not set, this endpoint is hard-blocked for safety.
app.get('/internal/metrics', (req, res) => {
  const metricsToken = process.env.INTERNAL_METRICS_TOKEN;

  // If no token configured, completely block this endpoint
  if (!metricsToken) {
    return res.status(503).json({ error: 'Metrics endpoint not configured' });
  }

  // Require exact token match in header
  const providedToken = req.headers['x-internal-token'];
  if (!providedToken || providedToken !== metricsToken) {
    logger.warn('METRICS', 'Unauthorized /internal/metrics access attempt', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { getAISlotStatus } = require('./middleware/aiLimiter');
  res.status(200).json({
    uptime: process.uptime(),
    counters: logger.getCounters(),
    ai: getAISlotStatus(),
    timestamp: new Date().toISOString()
  });
});

// Public App Config Endpoint - allows mobile app to load pricing and feature flags dynamically
app.get('/api/config', (req, res) => {
  const { appConfig } = require('./config');
  res.status(200).json({
    success: true,
    data: {
      config: {
        subscriptionPrice: appConfig.subscriptionPrice,
        yearlyPrice: appConfig.yearlyPrice || 1699,
        offerPriceMonthly: appConfig.offerPriceMonthly || null,
        offerPriceYearly: appConfig.offerPriceYearly || null,
        freeFeatures: appConfig.freeFeatures || [],
        proFeatures: appConfig.proFeatures || [],
        maintenanceMode: appConfig.maintenanceMode,
        featureFlags: appConfig.featureFlags,
        aiLimits: appConfig.aiLimits
      }
    }
  });
});

const maintenanceMiddleware = require('./middleware/maintenance');

// API Routes
app.use(maintenanceMiddleware); // Block non-essential routes if maintenance mode is ON
app.use('/api/auth', authRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/captions', captionRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/dm-automation', dmAutomationRoutes);
app.use('/api/brand-deals', brandDealRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhook', webhookRoutes);

// 404 handler (must come before error middleware)
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let errorName = err.name || 'Error';
  let message = err.message;
  const userId = req.userId || 'unauthenticated';

  // Handle AppError (e.g. ValidationError)
  if (err.isOperational) {
    statusCode = err.statusCode;
    errorName = 'AppError';
  }

  // Handle express express.json() errors (e.g., SyntaxError for bad JSON)
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid JSON payload format' });
  }

  // Handle Prisma errors
  if (err.name === 'PrismaClientValidationError' || err.code === 'P2002') {
    statusCode = err.code === 'P2002' ? 409 : 400;
    errorName = err.name;
    message = process.env.NODE_ENV === 'production' ? 'Invalid or duplicate database operation' : err.message;
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorName = err.name;
    message = 'Authentication failed';
  }

  // Structured error log — critical for production diagnosis
  logger.error('HTTP_ERROR', `${errorName} on ${req.method} ${req.path}`, {
    statusCode,
    userId,
    errorName,
    message: err.message,
    stack: err.isOperational ? undefined : err.stack
  });

  // Only leak message if it's operational or not in production
  const isProduction = process.env.NODE_ENV === 'production';
  const displayMessage = (err.isOperational || !isProduction) ? message : 'Internal server error';

  res.status(statusCode).json({
    error: isProduction && !err.isOperational ? 'Internal server error' : errorName,
    message: displayMessage,
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`CloraAI Backend running`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Node version: ${process.version}`);
  console.log(`Port: ${PORT}`);
});

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  logger.info('SERVER', `${signal} received. Shutting down gracefully...`);
  // Stop all cron tasks cleanly
  if (schedulerTasks) schedulerTasks.forEach(t => t.stop());
  await releaseLock('scheduler').catch(() => { });
  await releaseLock('token-refresh').catch(() => { });
  await prisma.$disconnect();
  logger.info('SERVER', 'Shutdown complete.');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
