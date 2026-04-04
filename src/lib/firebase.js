const admin = require('firebase-admin');
const logger = require('../utils/logger');

let firebaseApp;

const initializeFirebase = () => {
  try {
    if (admin.apps.length > 0) {
      return admin.app();
    }

    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    let credential;

    if (serviceAccountJson) {
      try {
        const config = JSON.parse(serviceAccountJson);
        credential = admin.credential.cert(config);
        logger.info('FIREBASE', 'Initialized using JSON string from environment');
      } catch (e) {
        logger.error('FIREBASE', 'Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', { error: e.message });
      }
    } else if (serviceAccountPath) {
      credential = admin.credential.cert(require(serviceAccountPath));
      logger.info('FIREBASE', `Initialized using file: ${serviceAccountPath}`);
    }

    if (!credential) {
      if (process.env.NODE_ENV === 'production') {
        logger.error('FIREBASE', 'Missing Firebase credentials in production!');
      } else {
        logger.warn('FIREBASE', 'No Firebase credentials found. Push notifications will be disabled or mocked.');
        // In dev, we might not want to crash, just disable push
        return null;
      }
    }

    firebaseApp = admin.initializeApp({
      credential,
    });

    logger.info('FIREBASE', '✅ Firebase Admin SDK initialized successfully');
    return firebaseApp;
  } catch (error) {
    logger.error('FIREBASE', '❌ Firebase initialization failed:', { error: error.message });
    return null;
  }
};

module.exports = { admin, initializeFirebase };
