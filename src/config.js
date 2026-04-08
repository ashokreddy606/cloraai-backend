const prisma = require('./lib/prisma');

// Default config values
const defaultAppConfig = {
    subscriptionPrice: 299,
    yearlyPrice: 2499,
    offerPriceMonthly: null,
    offerPriceYearly: null,
    freeFeatures: [
        "1 Instagram Automation Rule",
        "5 YouTube Automation Rules",
        "Standard Analytics & Charts"
    ],
    proFeatures: [
        "Unlimited Automation Rules",
        "Premium Leads Export (CSV)",
        "Deep Analytics + Historic Graphs",
        "24/7 Priority Support & Beta"
    ],
    maintenanceMode: false,
    minAppVersion: '1.1.0',
    featureFlags: {
        youtubeEnabled: true,
        autoDMEnabled: true,
        instagramAutomationEnabled: true,
        instagramAIRepliesEnabled: true,
        instagramCustomRepliesEnabled: true,
        youtubeAutomationEnabled: true,
        youtubeAIRepliesEnabled: true,
        youtubeCustomRepliesEnabled: true,
        maintenanceMode: false,
    },
    aiLimits: {
        freeDailyDMs: 10,
        proDailyDMs: 500,
        aiTemperature: 0.7,
        aiModel: 'gpt-3.5-turbo',
    },
    blockedFromAI: [],
};

// Use const and mutate it so references remain intact across files
const appConfig = { ...defaultAppConfig };

const initConfig = async () => {
    try {
        let dbConfig = await prisma.systemConfig.findUnique({
            where: { key: 'global_config' }
        });
        
        if (!dbConfig) {
            dbConfig = await prisma.systemConfig.create({
                data: {
                    key: 'global_config',
                    value: JSON.stringify(defaultAppConfig)
                }
            });
        }
        
        const parsed = JSON.parse(dbConfig.value);
        Object.assign(appConfig, {
            ...defaultAppConfig,
            ...parsed,
            featureFlags: { ...defaultAppConfig.featureFlags, ...(parsed.featureFlags || {}) },
            aiLimits: { ...defaultAppConfig.aiLimits, ...(parsed.aiLimits || {}) }
        });
        console.log('System configuration loaded from database.');
    } catch (err) {
        console.error('Failed to init SystemConfig from DB:', err.message);
    }
};

// Function to save current config to disk (now database)
const saveConfig = async () => {
    try {
        await prisma.systemConfig.upsert({
            where: { key: 'global_config' },
            update: { value: JSON.stringify(appConfig) },
            create: { key: 'global_config', value: JSON.stringify(appConfig) }
        });
    } catch (err) {
        console.error('Failed to save config to DB:', err.message);
    }
};

module.exports = {
    appConfig,
    saveConfig,
    initConfig
};
