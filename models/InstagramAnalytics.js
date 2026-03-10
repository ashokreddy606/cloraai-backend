const mongoose = require('mongoose');

const InstagramAnalyticsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    followers: {
        type: Number,
        default: 0
    },
    posts: {
        type: Number,
        default: 0
    },
    following: {
        type: Number,
        default: 0
    },
    reach: {
        type: Number,
        default: 0
    },
    impressions: {
        type: Number,
        default: 0
    },
    date: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: true
});

// Compound index for unique daily snapshots per user
InstagramAnalyticsSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('InstagramAnalytics', InstagramAnalyticsSchema);
