const { PrismaClient } = require('@prisma/client');

let prisma;

// Set connection pool limit explicitly for MongoDB
const dbUrl = (process.env.DATABASE_URL || '').trim();
let pooledDbUrl = dbUrl;

if (dbUrl) {
    if (!dbUrl.includes('maxPoolSize')) {
        pooledDbUrl = `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}maxPoolSize=50`;
    }
} else {
    console.error('[PRISMA_DEBUG] DATABASE_URL is missing or empty');
}

// Masked log for debugging
if (pooledDbUrl) {
    const isMongo = pooledDbUrl.startsWith('mongodb');
    console.log(`[PRISMA_DEBUG] URL protocol check: ${isMongo ? 'OK (Starts with mongodb)' : 'FAIL (Starts with ' + pooledDbUrl.substring(0, 7) + ')'}`);
}

if (process.env.NODE_ENV === 'production') {
    prisma = new PrismaClient({
        datasources: { db: { url: pooledDbUrl } }
    });
} else {
    // In development/test, use a global variable so the client is not re-initialized
    // every time the code changes (and HMR fires).
    if (!global.prisma || process.env.NODE_ENV === 'test') {
        global.prisma = new PrismaClient({
            datasources: { db: { url: pooledDbUrl } }
        });
    }
    prisma = global.prisma;
}

module.exports = prisma;
