const axios = require('axios');
const UAParser = require('ua-parser-js');

/**
 * Detects device information from User-Agent string
 * @param {string} userAgent 
 * @returns {object} device info
 */
exports.detectDevice = (userAgent) => {
  const parser = new UAParser(userAgent);
  const result = parser.getResult();
  
  // Custom mapping for deviceType to match user requirements
  let deviceType = result.device.type || 'desktop';
  if (deviceType === 'mobile' || deviceType === 'tablet') {
    // Keep as is
  } else {
    deviceType = 'desktop';
  }

  return {
    deviceName: `${result.device.vendor || ''} ${result.device.model || result.os.name || 'Unknown'}`.trim(),
    deviceType,
    deviceModel: result.device.model || 'Generic',
    browser: result.browser.name || 'Unknown',
    os: result.os.name || 'Unknown',
    userAgent: userAgent
  };
};

/**
 * Fetches location information from IP address
 * @param {string} ip 
 * @returns {object} location info
 */
exports.getLocationFromIp = async (ip) => {
  try {
    // Handle local development IPs
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return {
        city: 'Local',
        region: 'Development',
        country: 'System',
        timezone: 'UTC'
      };
    }

    // Using ip-api.com (Free for non-commercial)
    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    
    if (response.data && response.data.status === 'success') {
      const { city, regionName, country, timezone } = response.data;
      return {
        city: city || 'Unknown',
        region: regionName || 'Unknown',
        country: country || 'Unknown',
        timezone: timezone || 'UTC'
      };
    }
    
    return {
      city: 'Unknown',
      region: 'Unknown',
      country: 'Unknown',
      timezone: 'UTC'
    };
  } catch (error) {
    console.error('IP Location lookup failed:', error.message);
    return {
      city: 'Unknown',
      region: 'Unknown',
      country: 'Unknown',
      timezone: 'UTC'
    };
  }
};

/**
 * Simple suspicious login detection
 * @param {object} lastSession 
 * @param {object} currentSession 
 * @returns {boolean}
 */
exports.isSuspicious = (lastSession, currentSession) => {
  if (!lastSession) return false;

  // New country detection
  if (lastSession.country !== currentSession.country && lastSession.country !== 'Unknown' && currentSession.country !== 'Unknown') {
    return true;
  }

  // New critical device change detection (e.g. iOS to Android)
  if (lastSession.os !== currentSession.os) {
    return true;
  }

  return false;
};
