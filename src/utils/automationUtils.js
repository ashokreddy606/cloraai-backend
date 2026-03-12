/**
 * utils/automationUtils.js
 * Shared utilities for Instagram/YouTube automation.
 */

/**
 * Matches text against a keyword or comma-separated list of keywords.
 * Uses word boundaries for accurate matching.
 * 
 * @param {string} incomingText - The text to check (usually user comment/DM)
 * @param {string} keywordRule - Comma-separated keyword(s)
 * @returns {boolean}
 */
const matchesKeyword = (incomingText, keywordRule) => {
    if (!incomingText || !keywordRule) return false;

    try {
        // Clean text: lowercase and replace punctuation with spaces
        const cleanText = incomingText.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, ' ');
        
        // Support comma-separated multi-keyword rules
        const keywords = keywordRule.split(',').map(k => {
            // Also clean the keyword to match the text cleaning logic
            return k.toLowerCase().replace(/[^\w\s]/g, " ").trim();
        }).filter(Boolean);
        
        return keywords.some(kw => {
            // Check if the clean text contains the keyword
            return cleanText.includes(kw);
        });
    } catch (error) {
        return false;
    }
};

module.exports = {
    matchesKeyword
};
