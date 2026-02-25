const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyChain = require('proxy-chain');
const { generateFingerprint } = require('../utils/fingerprintGenerator');

// Enable stealth mode
puppeteer.use(StealthPlugin());

/**
 * Launch browser with advanced anti-detection
 */
async function launchStealthBrowser(account) {
  console.log(`[BROWSER] Launching stealth browser for ${account.email}`);
  
  let proxyUrl = null;
  let anonymousProxyUrl = null;
  
  // ========================================
  // STEP 1: Setup Proxy (HTTP or SOCKS5)
  // ========================================
  if (account.proxyHost && account.proxyPort) {
    const proxyType = account.proxyType || 'http'; // 'http' or 'socks5'
    
    console.log(`[PROXY] Using ${proxyType.toUpperCase()} proxy: ${account.proxyHost}:${account.proxyPort}`);
    
    if (account.proxyUsername && account.proxyPassword) {
      // Proxy with authentication - use proxy-chain to handle auth
      const originalProxy = `${proxyType}://${account.proxyUsername}:${account.proxyPassword}@${account.proxyHost}:${account.proxyPort}`;
      
      try {
        anonymousProxyUrl = await proxyChain.anonymizeProxy(originalProxy);
        proxyUrl = anonymousProxyUrl;
        console.log(`[PROXY] Authenticated proxy anonymized`);
      } catch (error) {
        console.error(`[PROXY] Failed to anonymize proxy:`, error.message);
        proxyUrl = `${proxyType}://${account.proxyHost}:${account.proxyPort}`;
      }
    } else {
      // Proxy without authentication
      proxyUrl = `${proxyType}://${account.proxyHost}:${account.proxyPort}`;
    }
  }
  
  // ========================================
  // STEP 2: Generate Fingerprint
  // ========================================
  const proxyIP = account.proxyHost || '8.8.8.8'; // Use proxy IP or fallback
  const fingerprint = generateFingerprint(proxyIP);
  
  console.log(`[FINGERPRINT] Generated for ${fingerprint.timezone} / ${fingerprint.locale}`);
  
  // ========================================
  // STEP 3: Browser Launch Arguments
  // ========================================
  const args = [
    // Basic flags
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    
    // Disable automation flags
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    
    // WebRTC leak prevention
    '--disable-webrtc',
    '--disable-webrtc-hw-encoding',
    '--disable-webrtc-encryption',
    '--enforce-webrtc-ip-permission-check',
    
    // Canvas/WebGL protection
    '--disable-accelerated-video-decode',
    '--disable-gpu-vsync',
    
    // Language
    `--lang=${fingerprint.locale}`,
    
    // Window size
    `--window-size=${fingerprint.screenWidth},${fingerprint.screenHeight}`,
    
    // Timezone (Note: This doesn't work reliably, we'll use page.emulateTimezone)
    `--timezone=${fingerprint.timezone}`,
    
    // Proxy
    proxyUrl ? `--proxy-server=${proxyUrl}` : null
  ].filter(Boolean);
  
  // ========================================
  // STEP 4: Launch Browser
  // ========================================
  const browser = await puppeteer.launch({
    headless: true,
    args: args,
    ignoreHTTPSErrors: true,
    defaultViewport: null
  });
  
  const page = await browser.newPage();
  
  // ========================================
  // STEP 5: Set Viewport & Screen
  // ========================================
  await page.setViewport({
    width: fingerprint.screenWidth,
    height: fingerprint.screenHeight,
    deviceScaleFactor: fingerprint.deviceScaleFactor,
    hasTouch: false,
    isLandscape: true,
    isMobile: false
  });
  
  // ========================================
  // STEP 6: Set User Agent
  // ========================================
  const userAgent = account.userAgent || 
    `Mozilla/5.0 (${fingerprint.platform}; ${fingerprint.os} ${fingerprint.osVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.59 Safari/537.36`;
  
  await page.setUserAgent(userAgent);
  console.log(`[USER-AGENT] ${userAgent}`);
  
  // ========================================
  // STEP 7: Set Extra HTTP Headers
  // ========================================
  await page.setExtraHTTPHeaders({
    'Accept-Language': `${fingerprint.locale},${fingerprint.language};q=0.9`,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  });
  
  // ========================================
  // STEP 8: Set Geolocation
  // ========================================
  if (fingerprint.latitude && fingerprint.longitude) {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://megapersonals.eu', ['geolocation']);
    
    await page.setGeolocation({
      latitude: fingerprint.latitude,
      longitude: fingerprint.longitude,
      accuracy: 100
    });
    
    console.log(`[GEO] Set to ${fingerprint.latitude}, ${fingerprint.longitude}`);
  }
  
  // ========================================
  // STEP 9: Emulate Timezone
  // ========================================
  try {
    await page.emulateTimezone(fingerprint.timezone);
    console.log(`[TIMEZONE] ${fingerprint.timezone}`);
  } catch (error) {
    console.warn(`[TIMEZONE] Failed to set timezone: ${error.message}`);
  }
  
  // ========================================
  // STEP 10: Inject Anti-Detection Scripts
  // ========================================
  await page.evaluateOnNewDocument((fp) => {
    // Override navigator properties
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
    
    Object.defineProperty(navigator, 'platform', {
      get: () => fp.platform
    });
    
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => fp.hardwareConcurrency
    });
    
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => fp.deviceMemory
    });
    
    Object.defineProperty(navigator, 'languages', {
      get: () => [fp.locale, fp.language]
    });
    
    Object.defineProperty(navigator, 'language', {
      get: () => fp.locale
    });
    
    // Override WebGL
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return fp.webglVendor;
      }
      if (parameter === 37446) {
        return fp.webglRenderer;
      }
      return getParameter.apply(this, [parameter]);
    };
    
    // Canvas fingerprint noise
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const shift = fp.canvasNoiseSeed.charCodeAt(0) % 10;
      const context = this.getContext('2d');
      const imageData = context.getImageData(0, 0, this.width, this.height);
      
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = (imageData.data[i] + shift) % 256;
      }
      
      context.putImageData(imageData, 0, 0);
      return toDataURL.apply(this, [type]);
    };
    
    // Remove automation indicators
    delete navigator.__proto__.webdriver;
    
    // Override chrome object
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });
    
    // Disable WebRTC IP leak
    const getStats = RTCPeerConnection.prototype.getStats;
    RTCPeerConnection.prototype.getStats = function() {
      return getStats.apply(this, arguments);
    };
    
  }, fingerprint);
  
  console.log(`✅ [BROWSER] Stealth browser launched successfully`);
  
  // Store fingerprint for later reference
  page._fingerprint = fingerprint;
  
  // Store proxy cleanup function
  page._cleanupProxy = async () => {
    if (anonymousProxyUrl) {
      try {
        await proxyChain.closeAnonymizedProxy(anonymousProxyUrl, true);
        console.log('[PROXY] Cleaned up anonymized proxy');
      } catch (err) {
        console.error('[PROXY] Cleanup error:', err.message);
      }
    }
  };
  
  return { browser, page };
}

module.exports = { launchStealthBrowser };
