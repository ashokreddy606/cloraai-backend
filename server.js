const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');
require('dotenv').config();
const validateEnv = require('./src/utils/envValidator');
validateEnv();

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
    logger.error('CRASH_PREVENTION', "UNCAUGHT EXCEPTION", { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('CRASH_PREVENTION', "UNHANDLED REJECTION", { reason });
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
const webhookRoutes = require('./src/routes/webhook');
const youtubeRoutes = require('./src/routes/youtube');
const uploadRoutes = require('./src/routes/upload');
const paymentRoutes = require('./src/routes/payment');

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

// Security: Log errors for missing keys, but only crash for CRITICAL ones
const criticalEnvs = [
    'JWT_SECRET',
    'DATABASE_URL',
];
const featureEnvs = [
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'INSTAGRAM_APP_SECRET',
    'ADMIN_SECRET_KEY',
    'GOOGLE_CLIENT_ID',
    'TOKEN_ENCRYPTION_SECRET',
];

const missingCritical = criticalEnvs.filter(env => !process.env[env]);
const missingFeatures = featureEnvs.filter(env => !process.env[env]);

if (missingCritical.length > 0) {
    const msg = `FATAL: Missing critical environment variables: ${missingCritical.join(', ')}`;
    logger.error('SERVER', msg);
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
}

if (missingFeatures.length > 0) {
    logger.warn('SERVER', `Missing feature-specific environment variables: ${missingFeatures.join(', ')}. Some features will be disabled.`);
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

// Compress responses
app.use(compression());

// Security middleware — Helmet sets secure HTTP headers.
// CSP properly restricts unauthorized executions.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "https://checkout.razorpay.com"], // Removed unsafe-inline for tighter security
            frameSrc: ["'self'", "https://api.razorpay.com", "https://tds.razorpay.com"],
            imgSrc: ["'self'", "data:", "https://*.razorpay.com", "https://cloraai.com", "https://s3.amazonaws.com"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "https://lumberjack.razorpay.com", "https://api.razorpay.com"],
            objectSrc: ["'none'"],
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

// Prevent Cross-Site Scripting (XSS)
app.use(xss());

// Prevent NoSQL Injection
app.use(mongoSanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());

// CORS — restrict in production
const allowedOrigins = [
    'http://localhost:8081',   // Expo mobile dev
    'http://localhost:19000',  // Legacy Expo dev
    'http://localhost:19006',  // Expo web dev
    'http://localhost:5173',   // Vite admin dev (default)
    'http://localhost:5174',   // Vite admin dev (fallback port)
    'http://localhost:5175',   // Vite admin dev (tertiary fallback)
    'http://localhost:3000',   // Generic React/Node
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'null',                     // Some mobile webviews
    'file://',                  // Some mobile webviews
];

if (process.env.FRONTEND_URL) {
    process.env.FRONTEND_URL.split(',').forEach(url => allowedOrigins.push(url.trim()));
}

app.use(cors({
    origin: (origin, callback) => {
        // [DEBUG] Log incoming origin for CORS troubleshooting
        // if (origin) logger.info('CORS', `Incoming request from origin: ${origin}`);

        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return callback(null, true);

        // Allow common origins
        if (allowedOrigins.includes(origin)) return callback(null, true);

        // Broaden matching for Expo/Tunnel origins or development
        if (process.env.NODE_ENV !== 'production' || origin.includes('expo.dev') || origin.includes('ngrok') || origin.includes('railway.app')) {
            return callback(null, true);
        }

        logger.warn('CORS', `Origin ${origin} blocked by policy`);
        callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Internal-Token']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global rate limiting (200 requests per 15 minutes per IP)
app.use(rateLimit(200, 15));

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
app.use('/api/v1/payment', paymentRoutes);
app.use('/api/v1/calendar', calendarRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/youtube', youtubeRoutes);
app.use('/api/youtube', youtubeRoutes); // Fallback mount to handle legacy or misconfigured redirect URIs
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/upload', uploadRoutes);
// Webhooks must remain at non-versioned paths because external services (Razorpay, Instagram)
// send to fixed URLs that we cannot change after configuration.
app.use('/api/webhook', webhookRoutes);
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
        require('./src/workers/scheduledPostWorker'); // BullMQ — processes instagram-publish queue
        logger.info('SERVER', 'Scheduled post worker initialized.');
    } catch (err) {
        logger.error('SERVER', 'Failed to initialize scheduled post worker:', { error: err.message });
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
