const { PrismaClient } = require('@prisma/client');

let prisma;

// Set connection pool limit explicitly for MongoDB
const dbUrl = process.env.DATABASE_URL;
let pooledDbUrl = dbUrl;

if (dbUrl) {
    if (!dbUrl.includes('maxPoolSize')) {
        pooledDbUrl = `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}maxPoolSize=50`;
    }
    // Prisma 4 standard connection limit argument for robust scaling
    if (!dbUrl.includes('connection_limit')) {
        pooledDbUrl = `${pooledDbUrl}&connection_limit=50`;
    }
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
