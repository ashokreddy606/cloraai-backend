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
  
  // Mapping OS to be more precise as requested
  const osName = result.os.name || 'Unknown';
  const browserName = result.browser.name || 'Unknown';
  let deviceType = result.device.type || 'desktop';

  return {
    deviceType,
    deviceModel: result.device.model || 'Generic Device',
    os: osName,
    browser: browserName,
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
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return {
        city: 'Local',
        region: 'Development',
        country: 'System'
      };
    }

    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    
    if (response.data && response.data.status === 'success') {
      const { city, regionName, country } = response.data;
      return {
        city: city || 'Unknown City',
        region: regionName || 'Unknown Region',
        country: country || 'Unknown Country'
      };
    }
    
    return {
      city: 'Unknown City',
      region: 'Unknown Region',
      country: 'Unknown Country'
    };
  } catch (error) {
    logger.error('IP_LOCATION', 'Lookup failed', { error: error.message, ip });
    return {
      city: 'Unknown City',
      region: 'Unknown Region',
      country: 'Unknown Country'
    };
  }
};

/**
 * Simple suspicious login detection
 */
exports.isSuspicious = (lastSession, currentSession) => {
  if (!lastSession) return false;
  if (lastSession.country !== currentSession.country && lastSession.country !== 'Unknown Country') return true;
  if (lastSession.os !== currentSession.os) return true;
  return false;
};
