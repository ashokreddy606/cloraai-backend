const mongoose = require('mongoose');

const InstagramAccountSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        unique: true,
        index: true
    },
    instagramUserId: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: false
    },
    accessToken: {
        type: String,
        required: true
    },
    tokenExpiresAt: {
        type: Date,
        required: true
    },
    connectedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('InstagramAccount', InstagramAccountSchema);
