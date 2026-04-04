const mongoose = require('mongoose');
const logger = require('../utils/logger');

const dbUrl = (process.env.DATABASE_URL || '').trim();

if (!dbUrl) {
    logger.error('MONGOOSE', 'DATABASE_URL is missing or empty');
}

const connectDB = async () => {
    try {
        if (mongoose.connection.readyState >= 1) return;

        await mongoose.connect(dbUrl, {
            // No longer need deprecated options in newer Mongoose
            autoIndex: true, // Ensue unique indexes are created
        });

        logger.info('MONGOOSE', '✅ MongoDB (Mongoose) connected successfully');
    } catch (error) {
        logger.error('MONGOOSE', '❌ MongoDB connection failed:', { error: error.message });
        // Don't exit process here; Prisma might still be working or it might be a transient error.
    }
};

module.exports = connectDB;
