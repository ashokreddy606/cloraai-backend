const axios = require('axios');
const UAParser = require('ua-parser-js');
const logger = require('./logger');

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
    const normalizedIp = String(ip || '')
      .split(',')[0]
      .trim()
      .replace(/^::ffff:/, '');

    const isPrivateIp =
      !normalizedIp ||
      normalizedIp === '::1' ||
      normalizedIp === '127.0.0.1' ||
      normalizedIp.startsWith('192.168.') ||
      normalizedIp.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalizedIp) ||
      normalizedIp.startsWith('fe80:') ||
      normalizedIp.startsWith('fc') ||
      normalizedIp.startsWith('fd');

    if (isPrivateIp) {
      return {
        city: 'Local',
        region: 'Development',
        country: 'System'
      };
    }

    const response = await axios.get(`http://ip-api.com/json/${normalizedIp}`, {
      timeout: 2000
    });
    
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
    logger.warn('IP_LOCATION', 'Lookup failed, continuing with unknown location', {
      error: error.message,
      ip
    });
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
