const { appConfig } = require('../config');

// Middleware to block API requests when maintenance mode is active
const maintenanceMiddleware = (req, res, next) => {
    if (!appConfig.maintenanceMode) {
        return next();
    }

    // Explicitly allow admin routes so the admin panel still works
    if (req.path.startsWith('/api/admin')) {
        return next();
    }

    // Explicitly allow auth routes so admin can log in (and users get standard auth responses if needed, or we block user auth but allow admin auth - simpler to just allow all auth, the app is unusable anyway)
    // To be perfectly safe, let's allow all auth but frontend should show maintenance screen
    if (req.path.startsWith('/api/auth')) {
        return next();
    }

    // Explicitly allow webhooks so we don't miss payments or incoming IG messages
    if (req.path.startsWith('/api/webhook')) {
        return next();
    }

    // explicit health check allow
    if (req.path === '/health' || req.path.startsWith('/internal')) {
        return next();
    }

    // For all other routes, return 503 Service Unavailable
    return res.status(503).json({
        success: false,
        error: 'Maintenance Mode',
        message: 'CloraAI is currently undergoing scheduled maintenance. Please try again later.'
    });
};

module.exports = maintenanceMiddleware;
