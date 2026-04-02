// Mock dependencies to avoid Redis/DB errors
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(path) {
  if (path.includes('redis') || path.includes('prisma') || path.includes('queue') || path.includes('cache')) {
    return {};
  }
  return originalRequire.apply(this, arguments);
};

process.env.DATABASE_URL = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'very-secret-key-that-is-at-least-64-characters-long-for-production-security';

try {
  const controller = require('./src/controllers/instagramController');
  console.log('Successfully loaded instagramController');
  console.log('Keys:', Object.keys(controller));
} catch (error) {
  console.error('FAILED TO LOAD:');
  console.error(error);
}
