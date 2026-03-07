const { MongoMemoryServer } = require('mongodb-memory-server');
const prisma = require('../src/lib/prisma');

let mongod;

beforeAll(async () => {
    // Setup environment variables for testing
    process.env.JWT_SECRET = 'test_jwt_secret_must_be_over_64_characters_long_for_security_reasons_1234567890';
    process.env.RAZORPAY_KEY_ID = 'test_key_id';
    process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.INSTAGRAM_APP_SECRET = 'test_insta_secret';
    process.env.ADMIN_SECRET_KEY = 'test_admin_key';
    process.env.GOOGLE_CLIENT_ID = 'test_google_client_id';
    process.env.TOKEN_ENCRYPTION_SECRET = 'test_token_encryption_secret_32_chars_';

    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    process.env.DATABASE_URL = uri;
    process.env.NODE_ENV = 'test';

    // Import prisma AFTER setting DATABASE_URL
    const prisma = require('../src/lib/prisma');
    // await prisma.$connect();
});

afterAll(async () => {
    await prisma.$disconnect();
    if (mongod) {
        await mongod.stop();
    }
});
