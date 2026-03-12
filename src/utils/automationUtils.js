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
        const text = incomingText.trim().toLowerCase().replace(/\s+/g, ' ');
        // Support comma-separated multi-keyword rules
        const keywords = keywordRule.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        
        return keywords.some(kw => {
            // Escape special regex chars, then use word boundaries
            // This ensures "help" doesn't match "helping"
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'i');
            return regex.test(text);
        });
    } catch (error) {
        return false;
    }
};

module.exports = {
    matchesKeyword
};
