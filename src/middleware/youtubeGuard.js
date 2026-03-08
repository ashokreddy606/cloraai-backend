const { appConfig } = require('../config');

const youtubeGuard = (req, res, next) => {
    if (!appConfig.featureFlags.youtubeEnabled) {
        return res.status(503).json({
            success: false,
            error: 'Feature Disabled',
            message: 'YouTube features are currently disabled by the administrator.'
        });
    }
    next();
};

const youtubeAutomationGuard = (req, res, next) => {
    if (!appConfig.featureFlags.youtubeAutomationEnabled) {
        return res.status(503).json({
            success: false,
            error: 'Feature Disabled',
            message: 'YouTube automation features are currently disabled.'
        });
    }
    next();
};

module.exports = {
    youtubeGuard,
    youtubeAutomationGuard
};
