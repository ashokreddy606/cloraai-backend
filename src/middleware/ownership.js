const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

/**
 * PRODUCTION SECURITY: RESOURCE OWNERSHIP VERIFICATION (Anti-IDOR)
 * 
 * This middleware ensures that the authenticated user (req.userId) 
 * is the owner of the resource being accessed/modified.
 * 
 * @param {string} modelName - The Prisma model name (e.g., 'dMAutomation', 'caption')
 * @param {string} idParam - The name of the route parameter containing the resource ID (default: 'id')
 */
const verifyResourceOwnership = (modelName, idParam = 'id') => {
    return catchAsync(async (req, res, next) => {
        const resourceId = req.params[idParam];
        const userId = req.userId;

        if (!resourceId) {
            return next(new AppError('Resource ID is required for ownership verification', 400));
        }

        if (!userId) {
            return next(new AppError('User must be authenticated for ownership verification', 401));
        }

        // Try to fetch the resource with the given ID
        const resource = await prisma[modelName].findUnique({
            where: { id: resourceId },
            select: { userId: true } // We only need the owner's ID
        });

        if (!resource) {
            return next(new AppError(`Resource not found in ${modelName}`, 404));
        }

        // Check if the authenticated user is the owner
        if (resource.userId !== userId) {
            console.error(`[SECURITY][IDOR] User ${userId} attempted to access ${modelName} ${resourceId} owned by ${resource.userId}`);
            return next(new AppError('Forbidden: You do not have permission to access this resource.', 403));
        }

        // Ownership verified
        next();
    });
};

module.exports = verifyResourceOwnership;
