const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');
require('dotenv').config();
const logger = require('./src/utils/logger');
const prisma = require('./src/lib/prisma');
const validateEnv = require('./src/utils/envValidator');
const fs = require('fs');
const path = require('path');
const connectDB = require('./src/lib/mongoose');
const { initializeFirebase } = require('./src/lib/firebase');

validateEnv();

// Initialize Prisma
// (Now using shared instance from src/lib/prisma.js)
connectDB();
initializeFirebase();

const { rateLimit } = require('./src/middleware/auth');

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
    // Log complete stack trace for debugging container exit
    if (err?.stack) console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    logger.error('CRASH_PREVENTION', "UNHANDLED REJECTION", { reason: reason instanceof Error ? reason.message : reason, stack: reason instanceof Error ? reason.stack : undefined });
    console.error('FATAL UNHANDLED REJECTION:', reason);
    if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

// Import routes
const authRoutes = require('./src/routes/auth');
const instagramRoutes = require('./src/routes/instagram');
const analyticsRoutes = require('./src/routes/analytics');
const subscriptionRoutes = require('./src/routes/subscription');
const dmAutomationRoutes = require('./src/routes/dmAutomation');
const referralRoutes = require('./src/routes/referral');
const adminRoutes = require('./src/routes/admin');
const adminPlanRoutes = require('./src/routes/adminPlan');
const userRoutes = require('./src/routes/user');
// Webhook routes removed (Razorpay cleanup)
const youtubeRoutes = require('./src/routes/youtube');
const accountRoutes = require('./src/routes/account');
const notificationRoutes = require('./src/routes/notification');
const webhookController = require('./src/controllers/webhookController');

// Initialize Prisma
// (Now using shared instance from src/lib/prisma.js)

// Initialize Express app
const app = express();

// Trust first proxy (Railway/Cloudflare) for correct IP detection in rate limiting
app.set('trust proxy', 1);

// ─── Global Request Logger ──────────────────────────────────────────────────
app.use((req, res, next) => {
    logger.info('API_REQUEST', `${req.method} ${req.originalUrl}`);
    next();
});

// HTML-encode helper for safe template rendering (prevents XSS)
const escapeHtml = (str) => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// ─── Debug Routes ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.send("CloraAI backend running");
});

app.get("/test", (req, res) => {
    res.send("Backend API is working");
});

// Webhook diagnostic (production-safe — no header logging)
app.get("/api/v1", (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'CloraAI API v1 is active and reachable.',
        documentation: 'https://cloraai.com/docs'
    });
});

app.get("/api/v1/webhook-test", (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'Webhook diagnostic endpoint is reachable!',
        yourIp: req.ip
    });
});

// ─── OAuth Landing Pages ──────────────────────────────────────────────────────
app.get('/youtube-success', (req, res) => {
    res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Account Connected - CloraAI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9fafb; }
                .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 90%; }
                h1 { color: #059669; }
                p { color: #4b5563; }
                .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #2563eb; color: white; text-decoration: none; border-radius: 0.5rem; font-weight: 500; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Success!</h1>
                <p>Your YouTube account has been successfully connected to CloraAI.</p>
                <a href="cloraai://youtube-success" class="btn">Return to App</a>
            </div>
            <script>
                // Automatically attempt to redirect back to the app after a short delay
                setTimeout(function() {
                    window.location.href = "cloraai://youtube-success";
                }, 1500);
            </script>
        </body>
        </html>
    `);
});

app.get('/youtube-error', (req, res) => {
    const rawMessage = req.query.message || 'An unexpected error occurred during authentication.';
    const message = escapeHtml(rawMessage);
    res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Connection Failed - CloraAI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fef2f2; }
                .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 90%; }
                h1 { color: #dc2626; }
                p { color: #4b5563; }
                .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #2563eb; color: white; text-decoration: none; border-radius: 0.5rem; font-weight: 500; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Connection Failed</h1>
                <p>${message}</p>
                <a href="cloraai://youtube-error?message=${encodeURIComponent(rawMessage)}" class="btn">Retry in App</a>
            </div>
            <script>
                setTimeout(function() {
                    window.location.href = "cloraai://youtube-error?message=${encodeURIComponent(rawMessage)}";
                }, 1500);
            </script>
        </body>
        </html>
    `);
});

app.get('/instagram-success', (req, res) => {
    res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Instagram Connected - CloraAI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fdf2f8; }
                .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 90%; }
                h1 { color: #db2777; }
                p { color: #4b5563; }
                .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #2563eb; color: white; text-decoration: none; border-radius: 0.5rem; font-weight: 500; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Success!</h1>
                <p>Your Instagram account has been successfully connected to CloraAI.</p>
                <a href="cloraai://instagram-success" class="btn">Return to App</a>
            </div>
            <script>
                // Automatically attempt to redirect back to the app after a short delay
                setTimeout(function() {
                    window.location.href = "cloraai://instagram-success";
                }, 1500);
            </script>
        </body>
        </html>
    `);
});

app.get('/instagram-error', (req, res) => {
    const rawMessage = req.query.message || 'An unexpected error occurred during Instagram authentication.';
    const message = escapeHtml(rawMessage);
    res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Connection Failed - CloraAI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fef2f2; }
                .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 90%; }
                h1 { color: #dc2626; }
                p { color: #4b5563; }
                .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #2563eb; color: white; text-decoration: none; border-radius: 0.5rem; font-weight: 500; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Connection Failed</h1>
                <p>${message}</p>
                <a href="cloraai://instagram-error?message=${encodeURIComponent(rawMessage)}" class="btn">Retry in App</a>
            </div>
            <script>
                setTimeout(function() {
                    window.location.href = "cloraai://instagram-error?message=${encodeURIComponent(rawMessage)}";
                }, 1500);
            </script>
        </body>
        </html>
    `);
});

// ─── Security Enforcement ───────────────────────────────────────────────────
app.get('/privacy', (req, res) => {
    res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Privacy Policy - CloraAI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; color: #374151; line-height: 1.5; }
                h1 { color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
            </style>
        </head>
        <body>
            <h1>Privacy Policy</h1>
            <p><strong>Last Updated: March 20, 2026</strong></p>
            <p>CloraAI respects your privacy. This policy explains how we handle your data when you use our Instagram and YouTube integration services.</p>
            <h2>1. Data We Collect</h2>
            <p>We only collect the data necessary to provide our services, such as your basic profile info and media insights (reach/impressions) if you explicitly grant us permission.</p>
            <h2>2. How We Use Data</h2>
            <p>We use your data to show you analytics and to provide automation features like Auto-DMs and comment management.</p>
            <h2>3. Data Deletion</h2>
            <p>You can disconnect your account at any time within the CloraAI app settings to delete our access and remove your data from our system.</p>
        </body>
        </html>
    `);
});

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
        if (req.originalUrl && req.originalUrl.includes('/webhook')) {
            req.rawBody = buf; 
        }
    },
    limit: '50mb'
});

// Global Request Auditor moved to top

// 🔹 Webhook Verification (GET)
// Meta Dashboard needs this to verify the endpoint
app.get(['/webhook', '/api/v1/webhook', '/api/webhook'], (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
            logger.info('WEBHOOK', 'Handshake verified successfully');
            res.status(200).send(challenge);
        } else {
            logger.warn('WEBHOOK', 'Handshake token mismatch');
            res.sendStatus(403);
        }
    } else {
        res.json({ status: 'active', message: 'Ready to receive webhooks', endpoint: req.originalUrl });
    }
});

// 🔹 Webhook Payload Processing (POST)
// (MiddleWare already declared above)

// Controller already declared at the top of file

// Define POST routes BEFORE global body-parsers or CSRF/Redirect middleware
app.post(['/webhook', '/api/v1/webhook', '/api/webhook'], 
    webhookJsonMiddleware, 
    webhookController.handleWebhook
);

// ─── Security Enforcement ───────────────────────────────────────────────────

// Configure Express to parse query parameters literally (not nested)
// This is critical for Meta Webhooks which use dotted parameters like hub.mode
app.set('query parser', 'simple');


// Trust the first proxy (Nginx / AWS ALB / Cloud Run) so express-rate-limit
// and IP-based logic see the real client IP from X-Forwarded-For, not the proxy.
// IMPORTANT: Set to true on Railway to trust the full proxy chain.
app.set('trust proxy', true);

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

// ── CSRF Origin Validation ─────────────────────────────────────────────────
// Validates Origin/Referer header for state-changing requests from web clients.
// Mobile apps using Bearer tokens are not vulnerable to CSRF.
app.use((req, res, next) => {
    // Skip for safe HTTP methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Skip for webhook paths (Meta sends POST without Origin)
    if (req.path.startsWith('/webhook')) return next();
    // Skip if request has Authorization Bearer header (mobile app — not CSRF-vulnerable)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) return next();
    // Skip in non-production (dev tools don't always send Origin)
    if (process.env.NODE_ENV !== 'production') return next();

    // For web admin panel: validate Origin header ONLY if it exists.
    // Native mobile apps don't always send an Origin/Referer header and are not CSRF-vulnerable.
    const origin = req.headers.origin || req.headers.referer;
    if (!origin) return next();

    const originHost = new URL(origin).origin;
    if (!allowedOrigins.includes(originHost)) {
        // In production, also allow local network origins for mobile development convenience
        if (originHost.startsWith('http://192.168.') || originHost.startsWith('http://10.')) {
            return next();
        }
        logger.warn('CSRF', `Blocked CSRF attempt from ${originHost}`, { path: req.path, ip: req.ip });
        return res.status(403).json({ error: 'Forbidden: Invalid Origin' });
    }
    next();
});

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
        // 1. Allow requests with no origin (native mobile apps usually don't send one)
        if (!origin) return callback(null, true);

        // 2. Allow explicitly whitelisted origins
        if (allowedOrigins.includes(origin)) return callback(null, true);

        // 3. Robust check for mobile development and common native APK origins
        const isMobileDev = origin.startsWith('http://localhost') || 
                            origin.startsWith('http://127.0.0.1') || 
                            origin.startsWith('http://192.168.') || 
                            origin.startsWith('http://10.') ||
                            origin.startsWith('file://') ||
                            origin.startsWith('chrome-extension://');

        if (isMobileDev) return callback(null, true);

        // 4. In production, we log but still allow if it looks like it's coming from a mobile environment 
        // to prevent "Network Error" on fragmented Android ROMs.
        // (Actual API security is handled via JWT and Rate Limiting)
        if (process.env.NODE_ENV === 'production' && !origin.includes('.')) {
            // "origin" without dots usually means a local/internal android reference
            return callback(null, true);
        }

        logger.warn('CORS', `Origin ${origin} blocked by security policy`);
        // Instead of returning an Error object (which resets the connection), we return false
        // so the browser gets a standard CORS rejection response instead of a Network Error.
        callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Internal-Token', 'Origin']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global rate limiting (2000 requests per 15 minutes per IP)
// Multi-instance safe via Redis (configured in src/middleware/auth.js)
const globalLimiter = rateLimit(2000, 15);

app.use((req, res, next) => {
    // ─── RATE LIMIT EXCLUSIONS ──────────────────────────────────────────────
    // 1. Webhooks: Handled by dedicated lighter limiter to prevent blocking Meta.
    if (req.path.startsWith("/webhook") || req.path.startsWith("/api/v1/webhook")) {
        return webhookLimiter(req, res, next);
    }
    
    // 2. Auth Routes: Skip global limiter because they use specialized brute-force 
    // protection (authLimiterLogin, etc). Applying both causes ERR_ERL_DOUBLE_COUNT.
    if (req.path.startsWith("/auth") || req.path.startsWith("/api/v1/auth")) {
        return next();
    }

    return globalLimiter(req, res, next);
});

// Request Tracing & Logging Middleware
const tracing = require('./src/middleware/tracing');
app.use(tracing);

// Subscription Expiry Check — only runs on versioned API routes (not health, webhooks, etc)
const checkSubscriptionExpiry = require('./src/middleware/checkSubscriptionExpiry');

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
app.use('/api/v1/instagram', checkSubscriptionExpiry, instagramRoutes);
app.use('/api/v1/analytics', checkSubscriptionExpiry, analyticsRoutes);
app.use('/api/v1/subscription', checkSubscriptionExpiry, subscriptionRoutes);
app.use('/api/v1/dm-automation', checkSubscriptionExpiry, dmAutomationRoutes);
app.use('/api/v1/referral', checkSubscriptionExpiry, referralRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin-plans', adminPlanRoutes);
app.use('/api/v1/youtube', checkSubscriptionExpiry, youtubeRoutes);
app.use('/api/youtube', youtubeRoutes); // Fallback mount to handle legacy or misconfigured redirect URIs
app.use('/api/v1/user', checkSubscriptionExpiry, userRoutes);
app.use('/api/v1/account', accountRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// ─── Webhook Endpoints (Legacy Definitions Handled Above) ───────────────────

// ================= WEBHOOK ROUTES END =================

// 404 handler (must come before error middleware)
app.use((req, res, next) => {
    const message = `Route not found: ${req.method} ${req.originalUrl}`;
    logger.warn('404', message);
    res.status(404).json({
        success: false,
        error: 'Not found',
        message: message,
        hint: req.method === 'GET' && req.originalUrl.includes('login') 
            ? 'Accessing a POST route via browser (GET). Use Postman for login testing.' 
            : undefined
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


// API Initialization Status
logger.info('SERVER', '✅ API Server initialized (Workers isolated to dedicated process).');

// Start server
// Start server - Railway uses process.env.PORT (often 8080 or random)
// We prioritize process.env.PORT and fallback to 3000 for local dev
const PORT = process.env.PORT || 8080; 

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
