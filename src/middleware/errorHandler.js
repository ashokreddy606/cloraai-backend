const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
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
        return res.status(400).json({ error: 'Invalid JSON payload format', code: 'BAD_REQUEST' });
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

    // Railway-safe structurued response
    res.status(statusCode).json({
        error: isProduction && !err.isOperational ? 'Internal server error' : displayMessage,
        code: isProduction && !err.isOperational ? 'SERVER_ERROR' : errorName,
    });
};

module.exports = errorHandler;
