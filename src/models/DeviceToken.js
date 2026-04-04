const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  deviceId: {
    type: String,
    required: true,
  },
  fcmToken: {
    type: String,
    required: true,
  },
  platform: {
    type: String,
    enum: ['android', 'ios', 'web'],
    required: true,
  },
  lastActive: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Ensure a user cannot register the same device twice with different tokens
// Also provides fast lookup for a specific user's device
deviceTokenSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

// Export the model
module.exports = mongoose.model('DeviceToken', deviceTokenSchema, 'device_tokens');
