const mongoose = require('mongoose');
const { encryptToken, decryptToken } = require('../src/utils/cryptoUtils');

const InstagramAccountSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        unique: true,
        index: true
    },
    instagramId: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: false
    },
    pageId: {
        type: String,
        required: false
    },
    pageAccessToken: {
        type: String,
        required: false,
        set: encryptToken,
        get: decryptToken
    },
    instagramAccessToken: {
        type: String,
        required: true,
        set: encryptToken,
        get: decryptToken
    },
    accountType: {
        type: String,
        required: false
    },
    mediaCount: {
        type: Number,
        default: 0
    },
    tokenExpiresAt: {
        type: Date,
        required: true
    },
    isConnected: {
        type: Boolean,
        default: true
    },
    connectedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

module.exports = mongoose.model('InstagramAccount', InstagramAccountSchema);
