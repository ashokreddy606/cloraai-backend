/**
 * ─── TIER-AWARE PERFORMANCE CONFIG ─────────────────────────────────────────
 * Automatically detects the runtime environment (free-tier vs production)
 * and adjusts all performance parameters accordingly.
 *
 * FREE TIER  : <=1 GB RAM  → Conservative settings to avoid OOM crashes
 * PROD SMALL : <=4 GB RAM  → Balanced settings for growing scale
 * PROD LARGE : >4 GB RAM   → Full-throttle settings for 25K+ users
 */

const os = require('os');

// ─── Detect available RAM in GB ─────────────────────────────────────────────
const totalRAMgb = os.totalmem() / (1024 ** 3);

let TIER;
if (totalRAMgb <= 1.2) {
    TIER = 'FREE';
} else if (totalRAMgb <= 4.5) {
    TIER = 'SMALL';
} else {
    TIER = 'LARGE';
}

// ─── Tier Profiles ───────────────────────────────────────────────────────────
const PROFILES = {
    FREE: {
        // BullMQ Worker Concurrency
        concurrency: {
            webhook:      2,
            comment:      5,
            analytics:    2,
            youtube:      3,
            subscription: 1,
            tokenRefresh: 1,
        },
        // Redis Cache TTLs (seconds)
        cacheTTL: {
            instagramAccount: 120,   // Resolved IG accounts
            activeRules:      60,    // Automation rules per user
            activeAccounts:   90,    // Polling worker's account list
            userPlan:         180,   // User plan/subscription status
            mediaList:        300,   // Fetched media lists
        },
        // Batch / Polling limits
        batch: {
            analyticsConcurrentUsers: 2,
            pollTopMedia:             2,   // Only check 2 most recent posts
            pollCommentLimit:         20,  // Comments per post per poll cycle
        },
        // Polling intervals (cron expressions)
        cron: {
            instagramPoll: '*/3 * * * *',  // Every 3 min (not every 1 min)
            youtubePoll:   '*/5 * * * *',  // Every 5 min
        },
        // Backpressure thresholds
        backpressure: {
            commentQueue: 1000,
            youtubeQueue: 500,
        },
    },

    SMALL: {
        concurrency: {
            webhook:      10,
            comment:      20,
            analytics:    5,
            youtube:      10,
            subscription: 3,
            tokenRefresh: 5,
        },
        cacheTTL: {
            instagramAccount: 300,
            activeRules:      120,
            activeAccounts:   60,
            userPlan:         300,
            mediaList:        600,
        },
        batch: {
            analyticsConcurrentUsers: 10,
            pollTopMedia:             3,
            pollCommentLimit:         30,
        },
        cron: {
            instagramPoll: '*/2 * * * *',
            youtubePoll:   '*/2 * * * *',
        },
        backpressure: {
            commentQueue: 5000,
            youtubeQueue: 2000,
        },
    },

    LARGE: {
        concurrency: {
            webhook:      25,
            comment:      50,
            analytics:    10,
            youtube:      20,
            subscription: 10,
            tokenRefresh: 15,
        },
        cacheTTL: {
            instagramAccount: 600,
            activeRules:      300,
            activeAccounts:   30,
            userPlan:         600,
            mediaList:        900,
        },
        batch: {
            analyticsConcurrentUsers: 30,
            pollTopMedia:             3,
            pollCommentLimit:         50,
        },
        cron: {
            instagramPoll: '* * * * *',
            youtubePoll:   '* * * * *',
        },
        backpressure: {
            commentQueue: 10000,
            youtubeQueue: 5000,
        },
    },
};

const config = PROFILES[TIER];

// ─── Log tier on startup ─────────────────────────────────────────────────────
const logger = require('./logger');
logger.info('TIER_CONFIG', `⚡ Runtime Tier: ${TIER} (${totalRAMgb.toFixed(2)} GB RAM detected)`, {
    concurrency: config.concurrency,
    backpressure: config.backpressure,
});

module.exports = { TIER, config };
