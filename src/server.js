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
// These log errors but NEVER terminate the process to keep Railway container alive.
process.on('uncaughtException', (err) => {
  logger.error('CRASH_PREVENTION', "UNCAUGHT EXCEPTION", { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('CRASH_PREVENTION', "UNHANDLED REJECTION", { reason });
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
const youtubeRoutes = require('./routes/youtube');

// Initialize Prisma
const prisma = new PrismaClient();

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
  logger.error('SERVER', `Missing critical environment variables: ${missingEnvs.join(', ')}. Server might be unstable.`);
}

// JWT_SECRET minimum strength check (must be ≥ 64 characters).
// helpers.js also enforces this, but belt-and-suspenders catch at server entry.
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 64) {
  logger.error('SERVER', 'JWT_SECRET is too weak (must be ≥ 64 characters).');
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
const allowedOrigins = [
  'http://localhost:8081',   // Expo mobile dev
  'http://localhost:5173',   // Vite admin dev (default)
  'http://localhost:5174',   // Vite admin dev (fallback port)
  'http://localhost:5175',   // Vite admin dev (tertiary fallback)
  'http://localhost:3000',   // Generic React/Node
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

if (process.env.FRONTEND_URL) {
  process.env.FRONTEND_URL.split(',').forEach(url => allowedOrigins.push(url.trim()));
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // In development, allow everything
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
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

// Debug route
app.get("/test", (req, res) => {
  res.send("Backend API is working");
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage().heapUsed,
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
app.use('/api/youtube', youtubeRoutes);

// 404 handler (must come before error middleware)
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// Error handling middleware
const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

// Background Workers
require('./workers/youtubeWorker'); // Initialize YouTube cron job

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await prisma.$connect();
    console.log("Database connected");
  } catch (error) {
    console.error("Database connection failed, server will still start:", error);
  }

  // Bind to port unconditionally for Railway health checks
  app.listen(PORT, () => {
    console.log("🚀 CloraAI Backend running");
    console.log("Environment:", process.env.NODE_ENV);
    console.log("Node version:", process.version);
    console.log("Port:", PORT);
  });
};

startServer();

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  logger.info('SERVER', `${signal} received. Shutting down gracefully...`);
  await prisma.$disconnect();
  logger.info('SERVER', 'Shutdown complete.'); // process.exit is intentionally removed to avoid SIGTERM issues
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
