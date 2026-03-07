const crypto = require('crypto');
const logger = require('../utils/logger');

const tracing = (req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);

    const start = process.hrtime();

    // Log response when finished
    res.on('finish', () => {
        const diff = process.hrtime(start);
        const responseTime = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);

        logger.info('HTTP', `${req.method} ${req.originalUrl}`, {
            requestId: req.id,
            userId: req.userId || 'unauthenticated',
            route: req.route ? req.route.path : req.path,
            statusCode: res.statusCode,
            responseTime: `${responseTime}ms`,
            ip: req.ip
        });
    });

    next();
};

module.exports = tracing;
