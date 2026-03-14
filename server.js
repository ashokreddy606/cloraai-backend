const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');
const mongoose = require('mongoose');
require('dotenv').config();
const validateEnv = require('./src/utils/envValidator');
const fs = require('fs');
const path = require('path');
validateEnv();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Initialize Mongoose (requested for Instagram Analytics)
mongoose.connect(process.env.DATABASE_URL)
    .then(() => logger.info('SERVER', 'Mongoose connected successfully'))
    .catch((err) => logger.error('SERVER', 'Mongoose connection error:', { error: err.message }));

const { rateLimit } = require('./src/middleware/auth');
const prisma = require('./src/lib/prisma');
const logger = require('./src/utils/logger');

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
    logger.error('CRASH_PREVENTION', "UNCAUGHT EXCEPTION", { error: err?.message, stack: err?.stack });
    console.error('FATAL UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
    logger.error('CRASH_PREVENTION', "UNHANDLED REJECTION", { reason });
    console.error('FATAL UNHANDLED REJECTION:', reason);
});

// Import routes
const authRoutes = require('./src/routes/auth');
const instagramRoutes = require('./src/routes/instagram');
const analyticsRoutes = require('./src/routes/analytics');
const captionRoutes = require('./src/routes/caption');
const subscriptionRoutes = require('./src/routes/subscription');
const schedulerRoutes = require('./src/routes/scheduler');
const dmAutomationRoutes = require('./src/routes/dmAutomation');
const brandDealRoutes = require('./src/routes/brandDeal');
const referralRoutes = require('./src/routes/referral');
const adminRoutes = require('./src/routes/admin');
const adminPlanRoutes = require('./src/routes/adminPlan');
const userRoutes = require('./src/routes/user');
const calendarRoutes = require('./src/routes/calendar');
const notificationRoutes = require('./src/routes/notification');
// Webhook routes removed (Razorpay cleanup)
const youtubeRoutes = require('./src/routes/youtube');
const uploadRoutes = require('./src/routes/upload');

// Initialize Prisma
// (Now using shared instance from src/lib/prisma.js)

// Initialize Express app
const app = express();

// ─── Debug Routes ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.send("CloraAI backend running");
});

app.get("/test", (req, res) => {
    res.send("Backend API is working");
});

// ─── Security Enforcement ───────────────────────────────────────────────────
// Check for critical missing environment variables.
if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 64) {
        logger.error('SERVER', 'CRITICAL: JWT_SECRET must be at least 64 characters in production.');
        process.exit(1);
    }
    if (!process.env.REDIS_URL) {
        logger.error('SERVER', 'CRITICAL: REDIS_URL is required for production scaling.');
    }
}

// Raw body capture for generic webhooks if needed
// app.use('/api/webhook/some-external-service', express.raw({ type: 'application/json' }));

// Raw body capture for Instagram webhook signature verification (X-Hub-Signature-256)
// Uses express.json() with a verify callback to attach rawBody to req before JSON parsing.
// Registered for both versioned and root webhook paths.
const webhookJsonMiddleware = express.json({
    verify: (req, res, buf) => {
        if (req.originalUrl.includes('/webhook')) {
            req.rawBody = buf; // Buffer — used by verifyInstagramSignature()
        }
    },
    limit: '50mb'
});

app.use('/api/webhook', webhookJsonMiddleware);
app.use('/webhook', webhookJsonMiddleware);

// Configure Express to parse query parameters literally (not nested)
// This is critical for Meta Webhooks which use dotted parameters like hub.mode
app.set('query parser', 'simple');


// Trust the first proxy (Nginx / AWS ALB / Cloud Run) so express-rate-limit
// and IP-based logic see the real client IP from X-Forwarded-For, not the proxy.
// IMPORTANT: Only set to 1 (single trusted proxy). Set to the actual number of
// proxies in front of your app in production if stacked.
app.set('trust proxy', 1);

// Compress responses
app.use(compression());

// Security middleware — Helmet sets secure HTTP headers.
// CSP properly restricts unauthorized executions.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Relax for checkout
    hsts: {
        maxAge: 31536000,              // 1 year
        includeSubDomains: true,
        preload: true,
    },
}));

// Enforce HTTPS Redirection in Production (Google Play Compliance)
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
});

// Configure Express to parse query parameters literally (not nested)
// This is critical for Meta Webhooks which use dotted parameters like hub.mode
app.set('query parser', 'simple');

// Prevent Cross-Site Scripting (XSS)
app.use(xss());

// Prevent NoSQL Injection - allow dots for Meta Webhook parameters
app.use(mongoSanitize({
    allowDots: true
}));

// Prevent HTTP Parameter Pollution
app.use(
    hpp({
        checkQuery: false
    })
);

// CORS — PRODUCTION SECURITY: Use a strict allowlist.
const allowedOrigins = [
    'http://localhost:8081',   // Expo mobile dev
    'http://localhost:5173',   // Vite admin dev
];

// Load production domains from environment
if (process.env.FRONTEND_URL) {
    // Expected format: "https://cloraai.com, https://admin.cloraai.com"
    process.env.FRONTEND_URL.split(',').forEach(url => allowedOrigins.push(url.trim()));
}

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return callback(null, true);

        // Allow explicitly whitelisted origins
        if (allowedOrigins.includes(origin)) return callback(null, true);

        // Broaden matching for development environments ONLY
        if (process.env.NODE_ENV !== 'production') {
            if (origin.includes('expo.dev') || origin.includes('ngrok') || origin.includes('localhost')) {
                return callback(null, true);
            }
        }

        logger.warn('CORS', `Origin ${origin} blocked by security policy`);
        callback(new Error(`Security Restriction: CORS origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Internal-Token']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use('/public/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Global rate limiting (100 requests per 15 minutes per IP)
// Multi-instance safe via Redis (configured in src/middleware/auth.js)
const globalLimiter = rateLimit(100, 15);

app.use((req, res, next) => {
    // Skip rate limit for health check and external webhooks
    if (req.path.startsWith("/webhook") || req.path === "/health") {
        return next();
    }
    return globalLimiter(req, res, next);
});

// Request Tracing & Logging Middleware
const tracing = require('./src/middleware/tracing');
app.use(tracing);

// Automatic Subscription Expiry Check
const checkSubscriptionExpiry = require('./src/middleware/checkSubscriptionExpiry');
app.use(checkSubscriptionExpiry);

// Prometheus Metrics Middleware
const promBundle = require('express-prom-bundle');
const { register, updateMetrics } = require('./src/utils/metrics');
const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    includeUp: true,
    promClient: { collectDefaultMetrics: {} },
    customLabels: { project_name: 'cloraai' },
    promRegistry: register,
    autoregister: false // Manually handle /internal/metrics for auth
});
app.use(metricsMiddleware);

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
app.get('/internal/metrics', async (req, res) => {
    const metricsToken = process.env.INTERNAL_METRICS_TOKEN;

    if (!metricsToken) {
        return res.status(503).json({ error: 'Metrics endpoint not configured' });
    }

    const providedToken = req.headers['x-internal-token'];
    if (!providedToken || providedToken !== metricsToken) {
        logger.warn('METRICS', 'Unauthorized /internal/metrics access attempt', { ip: req.ip });
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Refresh redis, queue data
    await updateMetrics();

    let metricsString = await register.metrics();

    // Append Prisma native metrics if enabled
    try {
        const prismaMetrics = await prisma.$metrics.prometheus();
        metricsString += '\n' + prismaMetrics;
    } catch (e) {
        // Silently ignore if `metrics` preview feature isn't enabled yet
    }

    res.set('Content-Type', register.contentType);
    res.send(metricsString);
});

// Public App Config Endpoint - allows mobile app to load pricing and feature flags dynamically
// Public App Config Endpoint - allows mobile app to load pricing and feature flags dynamically
const getAppConfig = (req, res) => {
    const { appConfig } = require('./src/config');
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
};

app.get('/api/config', getAppConfig);
app.get('/api/v1/config', getAppConfig); // Alias for versioned compatibility

const maintenanceMiddleware = require('./src/middleware/maintenance');

// API Routes (versioned under /api/v1/)
app.use(maintenanceMiddleware); // Block non-essential routes if maintenance mode is ON
app.use('/auth', authRoutes); // Root level auth for OAuth callbacks
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/instagram', instagramRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/captions', captionRoutes);
app.use('/api/v1/subscription', subscriptionRoutes);
app.use('/api/v1/scheduler', schedulerRoutes);
app.use('/api/v1/dm-automation', dmAutomationRoutes);
app.use('/api/v1/brand-deals', brandDealRoutes);
app.use('/api/v1/referral', referralRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin-plans', adminPlanRoutes);
app.use('/api/v1/calendar', calendarRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/youtube', youtubeRoutes);
app.use('/api/youtube', youtubeRoutes); // Fallback mount to handle legacy or misconfigured redirect URIs
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/upload', uploadRoutes);
// Webhook routes removed (Razorpay cleanup)
console.log('YouTube routes mounted at /api/v1/youtube');

// 404 handler (must come before error middleware)
app.use((req, res, next) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Sentry Error Handler (Must be before our custom handler)
if (process.env.SENTRY_DSN) {
    const Sentry = require('@sentry/node');
    Sentry.setupExpressErrorHandler(app);
}

// Error handling middleware
const errorHandler = require('./src/middleware/errorHandler');
app.use(errorHandler);

// Background Workers (Bypassed in tests to avoid Redis/Cron interference)
if (process.env.NODE_ENV !== 'test') {
    try {
        require('./src/workers/youtubeWorker'); // Initialize YouTube cron job
    } catch (err) {
        logger.error('SERVER', 'Failed to initialize YouTube worker:', { error: err.message });
    }
    try {
        // Redundant: src/worker.js now handles the instagram-publish queue
        // require('./src/workers/scheduledPostWorker'); 
        logger.info('SERVER', 'Scheduled post worker disabled (handled by dedicated worker service).');
    } catch (err) {
        logger.error('SERVER', 'Failed to initialize scheduled post worker:', { error: err.message });
    }
    try {
        require('./src/workers/instagramAnalyticsWorker'); // Start Instagram daily analytics cron
        logger.info('SERVER', 'Instagram analytics worker initialized.');
    } catch (err) {
        logger.error('SERVER', 'Failed to initialize Instagram analytics worker:', { error: err.message });
    }
    try {
        require('./src/workers/instagramAutomationWorker'); // Start Instagram automation worker
        logger.info('SERVER', 'Instagram automation worker initialized.');
    } catch (err) {
        logger.error('SERVER', 'Failed to initialize Instagram automation worker:', { error: err.message });
    }
    try {
        require('./src/workers/refreshInstagramTokenWorker'); // Start Instagram token refresh cron
        logger.info('SERVER', 'Instagram token refresh worker initialized.');
    } catch (err) {
        logger.error('SERVER', 'Failed to initialize Instagram token refresh worker:', { error: err.message });
    }
}

// Start server
const PORT = process.env.PORT || 3000;

if (require.main === module) {
    const server = app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on port ${PORT}`);
    });

    // Tune keepAliveTimeout for AWS ALB compatibility
    server.keepAliveTimeout = 65000; // 65 seconds
    server.headersTimeout = 66000; // 66 seconds

    // Graceful shutdown handler
    const gracefulShutdown = async (signal) => {
        logger.info('SERVER', `${signal} received. Shutting down gracefully...`);
        server.close(() => {
            prisma.$disconnect().then(() => {
                logger.info('SERVER', 'Shutdown complete.');
            });
        });
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

module.exports = app; // Export for testing
