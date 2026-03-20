/**
 * Helper to construct a safe redirect URL, ensuring no missing slashes 
 * between base and path. Handles both web URLs (http/https) and app schemes (cloraai://).
 */
const getRedirectUrl = (path, params = {}) => {
    // Default to app scheme if FRONTEND_URL is not defined
    let baseUrl = process.env.FRONTEND_URL || 'cloraai://';
    
    // For web URLs, ensure a trailing slash if missing
    if (baseUrl.startsWith('http') && !baseUrl.endsWith('/')) {
        baseUrl += '/';
    }
    
    // Construct final URL
    // For app schemes without a host (like 'cloraai://'), baseUrl + path is usually correct.
    // For web URLs with a trailing slash, baseUrl + path is also correct.
    let finalUrl = baseUrl.endsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;
    
    // Handle query params using URLSearchParams for proper encoding
    const query = new URLSearchParams(params).toString();
    if (query) {
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + query;
    }
    
    return finalUrl;
};

module.exports = { getRedirectUrl };
