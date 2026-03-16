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
  
  // Construct a readable device name
  let deviceName = '';
  if (result.device.vendor || result.device.model) {
    deviceName = `${result.device.vendor || ''} ${result.device.model || ''}`.trim();
  } else if (result.os.name) {
    deviceName = result.os.name;
    if (result.os.version) deviceName += ` ${result.os.version}`;
  } else {
    deviceName = 'Unknown Device';
  }

  return {
    deviceName,
    deviceType: result.device.type || 'desktop',
    browser: result.browser.name || 'Unknown',
    os: result.os.name || 'Unknown',
    userAgent: userAgent
  };
};

/**
 * Fetches location information from IP address
 * @param {string} ip 
 * @returns {string} city, country
 */
exports.getLocationFromIp = async (ip) => {
  try {
    // Handle local development IPs
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return 'Local Development';
    }

    // Using ip-api.com (Free for non-commercial, 45 requests/min)
    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    
    if (response.data && response.data.status === 'success') {
      const { city, regionName, country } = response.data;
      return `${city || regionName}, ${country}`;
    }
    
    return 'Unknown Location';
  } catch (error) {
    console.error('IP Location lookup failed:', error.message);
    return 'Unknown Location';
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

  // New country/city detection (very basic)
  if (lastSession.location !== currentSession.location && lastSession.location !== 'Unknown Location' && currentSession.location !== 'Unknown Location') {
    return true;
  }

  // New device detection
  if (lastSession.deviceName !== currentSession.deviceName || lastSession.os !== currentSession.os) {
    return true;
  }

  return false;
};
