const { google } = require('googleapis');
const path = require('path');

// Google Play Developer API setup
// You'll need a service account JSON key file. 
// For now, I'll structure it to use environment variables for the JSON key content 
// or a file path if provided.

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  // Look for credentials in GOOGLE_APPLICATION_CREDENTIALS env var
});

const androidpublisher = google.androidpublisher('v3');

/**
 * Verify a subscription purchase
 */
const verifySubscription = async (packageName, productId, token) => {
  try {
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    const res = await androidpublisher.purchases.subscriptions.get({
      packageName,
      subscriptionId: productId,
      token,
    });

    console.log('[GooglePlay] Subscription response:', res.data);
    
    // Status 0 means active
    const isActive = res.data.paymentState === 1 || res.data.startTimeMillis; 
    // paymentState: 0 (Pending), 1 (Received), 2 (Free trial), 3 (Deferred)
    // Note: check expiryTimeMillis
    
    return {
      success: true,
      data: res.data,
      active: parseInt(res.data.expiryTimeMillis) > Date.now(),
    };
  } catch (error) {
    console.error('[GooglePlay] Subscription verification error:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Verify a consumable (product) purchase
 */
const verifyProduct = async (packageName, productId, token) => {
  try {
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    const res = await androidpublisher.purchases.products.get({
      packageName,
      productId,
      token,
    });

    console.log('[GooglePlay] Product response:', res.data);

    // purchaseState 0 means purchased
    const isPurchased = res.data.purchaseState === 0;

    return {
      success: true,
      data: res.data,
      purchased: isPurchased,
    };
  } catch (error) {
    console.error('[GooglePlay] Product verification error:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Consume a product purchase (acknowledge and mark as used)
 */
const consumeProduct = async (packageName, productId, token) => {
    try {
        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        await androidpublisher.purchases.products.consume({
            packageName,
            productId,
            token,
        });

        return { success: true };
    } catch (error) {
        console.error('[GooglePlay] Product consume error:', error);
        return { success: false, error: error.message };
    }
};

module.exports = {
  verifySubscription,
  verifyProduct,
  consumeProduct,
};
