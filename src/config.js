const fs = require('fs');
const path = require('path');

const configFilePath = path.join(__dirname, 'config.json');

// Default config values
const defaultAppConfig = {
    subscriptionPrice: 199,
    yearlyPrice: 1699,
    offerPriceMonthly: null,
    offerPriceYearly: null,
    freeFeatures: [
        "3 AI captions per day",
        "1 DM rule",
        "Basic analytics",
        "7-day calendar"
    ],
    proFeatures: [
        "Unlimited AI Captions",
        "Unlimited Auto-DM Rules",
        "AI Brand Deal Detection",
        "Full Year Content Calendar",
        "Advanced Analytics + Graphs",
        "24/7 Priority Support & Beta"
    ],
    maintenanceMode: false,
    minAppVersion: '1.0.0',
    featureFlags: {
        aiCaptionsEnabled: true,
        autoDMEnabled: true,
        reelSchedulerEnabled: true,
        brandDealsEnabled: true,
    },
    aiLimits: {
        freeDailyCaptions: 5,
        proDailyCaptions: 100,
        freeDailyDMs: 10,
        proDailyDMs: 500,
        aiTemperature: 0.7,
        aiModel: 'gpt-3.5-turbo',
    },
    blockedFromAI: [], // userIds blocked from AI
};

let appConfig = { ...defaultAppConfig };

// Synchronously load from file if it exists
if (fs.existsSync(configFilePath)) {
    try {
        const fileData = fs.readFileSync(configFilePath, 'utf8');
        const parsed = JSON.parse(fileData);
        // Merge defaults with saved config to ensure no missing keys
        appConfig = { ...defaultAppConfig, ...parsed };
    } catch (err) {
        console.error('Failed to parse config.json, using defaults:', err);
    }
}

// Function to save current config to disk
const saveConfig = () => {
    try {
        fs.writeFileSync(configFilePath, JSON.stringify(appConfig, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save config.json:', err);
    }
};

module.exports = {
    appConfig,
    saveConfig
};
