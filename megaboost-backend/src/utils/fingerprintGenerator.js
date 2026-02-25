const geoip = require('geoip-lite');

// Screen resolutions (common real-world resolutions)
const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080, ratio: 1 },
  { width: 1366, height: 768, ratio: 1 },
  { width: 1440, height: 900, ratio: 1 },
  { width: 1536, height: 864, ratio: 1 },
  { width: 2560, height: 1440, ratio: 1 },
  { width: 1280, height: 720, ratio: 1 },
  { width: 1600, height: 900, ratio: 1 }
];

// WebGL vendor/renderer pairs
const WEBGL_VENDORS = [
  { vendor: 'Intel Inc.', renderer: 'Intel Iris OpenGL Engine' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)' },
  { vendor: 'Apple Inc.', renderer: 'Apple GPU' },
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce GTX 1060/PCIe/SSE2' },
  { vendor: 'AMD', renderer: 'AMD Radeon Pro 5500M OpenGL Engine' }
];

// Platform/OS combinations
const PLATFORMS = [
  { platform: 'MacIntel', os: 'Mac OS', osVersion: '10_15_7' },
  { platform: 'Win32', os: 'Windows', osVersion: '10.0' },
  { platform: 'Linux x86_64', os: 'Linux', osVersion: '' }
];

// Hardware concurrency (CPU cores)
const CPU_CORES = [4, 8, 12, 16];

// Device memory (GB)
const DEVICE_MEMORY = [4, 8, 16, 32];

/**
 * Get timezone and locale from IP address
 */
function getLocationFromIP(ipAddress) {
  try {
    const geo = geoip.lookup(ipAddress);
    
    if (!geo) {
      return {
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        latitude: 37.7749,
        longitude: -122.4194,
        country: 'US'
      };
    }
    
    return {
      timezone: geo.timezone || 'America/Los_Angeles',
      locale: getLocaleFromCountry(geo.country),
      latitude: geo.ll[0],
      longitude: geo.ll[1],
      country: geo.country
    };
  } catch (error) {
    console.error('Error getting location from IP:', error);
    return {
      timezone: 'America/Los_Angeles',
      locale: 'en-US',
      latitude: 37.7749,
      longitude: -122.4194,
      country: 'US'
    };
  }
}

/**
 * Get locale from country code
 */
function getLocaleFromCountry(countryCode) {
  const localeMap = {
    'US': 'en-US',
    'GB': 'en-GB',
    'CA': 'en-CA',
    'AU': 'en-AU',
    'FR': 'fr-FR',
    'DE': 'de-DE',
    'ES': 'es-ES',
    'IT': 'it-IT',
    'BR': 'pt-BR',
    'MX': 'es-MX',
    'JP': 'ja-JP',
    'CN': 'zh-CN',
    'IN': 'en-IN'
  };
  
  return localeMap[countryCode] || 'en-US';
}

/**
 * Generate random screen resolution
 */
function generateScreenResolution() {
  return SCREEN_RESOLUTIONS[Math.floor(Math.random() * SCREEN_RESOLUTIONS.length)];
}

/**
 * Generate random WebGL vendor/renderer
 */
function generateWebGL() {
  return WEBGL_VENDORS[Math.floor(Math.random() * WEBGL_VENDORS.length)];
}

/**
 * Generate random platform
 */
function generatePlatform() {
  return PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
}

/**
 * Generate random hardware specs
 */
function generateHardware() {
  return {
    cores: CPU_CORES[Math.floor(Math.random() * CPU_CORES.length)],
    memory: DEVICE_MEMORY[Math.floor(Math.random() * DEVICE_MEMORY.length)]
  };
}

/**
 * Generate complete browser fingerprint
 */
function generateFingerprint(proxyIP) {
  const location = getLocationFromIP(proxyIP);
  const screen = generateScreenResolution();
  const webgl = generateWebGL();
  const platform = generatePlatform();
  const hardware = generateHardware();
  
  return {
    // Location & Locale
    timezone: location.timezone,
    locale: location.locale,
    language: location.locale.split('-')[0],
    latitude: location.latitude,
    longitude: location.longitude,
    country: location.country,
    
    // Screen
    screenWidth: screen.width,
    screenHeight: screen.height,
    deviceScaleFactor: screen.ratio,
    
    // WebGL
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    
    // Platform
    platform: platform.platform,
    os: platform.os,
    osVersion: platform.osVersion,
    
    // Hardware
    hardwareConcurrency: hardware.cores,
    deviceMemory: hardware.memory,
    
    // Canvas noise seed (random)
    canvasNoiseSeed: Math.random().toString(36).substring(7)
  };
}

module.exports = {
  generateFingerprint,
  getLocationFromIP,
  generateScreenResolution,
  generateWebGL,
  generatePlatform,
  generateHardware
};
