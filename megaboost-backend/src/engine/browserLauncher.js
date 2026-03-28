const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyChain = require('proxy-chain');
const { generateFingerprint } = require('../utils/fingerprintGenerator');

// Enable stealth mode
puppeteer.use(StealthPlugin());

function parseTimeoutMs(value, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.floor(parsed);
}

const PROXY_ANONYMIZE_TIMEOUT_MS = parseTimeoutMs(
  process.env.PROXY_ANONYMIZE_TIMEOUT_MS,
  20000
);
const BROWSER_LAUNCH_TIMEOUT_MS = parseTimeoutMs(
  process.env.BROWSER_LAUNCH_TIMEOUT_MS,
  120000
);
const BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS = parseTimeoutMs(
  process.env.BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
  30000
);

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/**
 * Launch browser with advanced anti-detection
 */
async function launchStealthBrowser(account) {
  console.log(`[BROWSER] Launching stealth browser for ${account.email}`);
  
  let proxyUrl = null;
  let anonymousProxyUrl = null;
  let proxyCleanedUp = false;

  const cleanupAnonymousProxy = async () => {
    if (!anonymousProxyUrl || proxyCleanedUp) {
      return;
    }

    proxyCleanedUp = true;
    try {
      await proxyChain.closeAnonymizedProxy(anonymousProxyUrl, true);
      console.log('[PROXY] Cleaned up anonymized proxy');
    } catch (err) {
      console.error('[PROXY] Cleanup error:', err.message);
    }
  };
  
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
        anonymousProxyUrl = await withTimeout(
          proxyChain.anonymizeProxy(originalProxy),
          PROXY_ANONYMIZE_TIMEOUT_MS,
          'Proxy anonymize'
        );
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
  let browser = null;
  let page = null;

  try {
    browser = await withTimeout(
      puppeteer.launch({
        headless: true,
        args: args,
        ignoreHTTPSErrors: true,
        defaultViewport: null
      }),
      BROWSER_LAUNCH_TIMEOUT_MS,
      'Browser launch'
    );
    
    page = await withTimeout(
      browser.newPage(),
      BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
      'Open new browser page'
    );
    
    // ========================================
    // STEP 5: Set Viewport & Screen
    // ========================================
    await withTimeout(
      page.setViewport({
        width: fingerprint.screenWidth,
        height: fingerprint.screenHeight,
        deviceScaleFactor: fingerprint.deviceScaleFactor,
        hasTouch: false,
        isLandscape: true,
        isMobile: false
      }),
      BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
      'Set viewport'
    );
    
    // ========================================
    // STEP 6: Set User Agent
    // ========================================
    const userAgent = account.userAgent || 
      `Mozilla/5.0 (${fingerprint.platform}; ${fingerprint.os} ${fingerprint.osVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.59 Safari/537.36`;
    
    await withTimeout(
      page.setUserAgent(userAgent),
      BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
      'Set user agent'
    );
    console.log(`[USER-AGENT] ${userAgent}`);
    
    // ========================================
    // STEP 7: Set Extra HTTP Headers
    // ========================================
    await withTimeout(
      page.setExtraHTTPHeaders({
        'Accept-Language': `${fingerprint.locale},${fingerprint.language};q=0.9`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }),
      BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
      'Set HTTP headers'
    );
    
    // ========================================
    // STEP 8: Set Geolocation
    // ========================================
    if (fingerprint.latitude && fingerprint.longitude) {
      const context = browser.defaultBrowserContext();
      await withTimeout(
        context.overridePermissions('https://megapersonals.eu', ['geolocation']),
        BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
        'Override geolocation permissions'
      );
      
      await withTimeout(
        page.setGeolocation({
          latitude: fingerprint.latitude,
          longitude: fingerprint.longitude,
          accuracy: 100
        }),
        BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
        'Set geolocation'
      );
      
      console.log(`[GEO] Set to ${fingerprint.latitude}, ${fingerprint.longitude}`);
    }
    
    // ========================================
    // STEP 9: Emulate Timezone
    // ========================================
    try {
      await withTimeout(
        page.emulateTimezone(fingerprint.timezone),
        BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
        'Emulate timezone'
      );
      console.log(`[TIMEZONE] ${fingerprint.timezone}`);
    } catch (error) {
      console.warn(`[TIMEZONE] Failed to set timezone: ${error.message}`);
    }
    
    // ========================================
    // STEP 10: Inject Anti-Detection Scripts
    // ========================================
    await withTimeout(
      page.evaluateOnNewDocument((fp) => {
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
        
      }, fingerprint),
      BROWSER_BOOTSTRAP_STEP_TIMEOUT_MS,
      'Inject anti-detection scripts'
    );
    
    console.log(`✅ [BROWSER] Stealth browser launched successfully`);
    
    // Store fingerprint for later reference
    page._fingerprint = fingerprint;
    
    // Store proxy cleanup function
    page._cleanupProxy = cleanupAnonymousProxy;
    
    return { browser, page };
  } catch (error) {
    if (browser) {
      try {
        if (typeof browser.isConnected === 'function') {
          if (browser.isConnected()) {
            await browser.close();
          }
        } else {
          await browser.close();
        }
      } catch (browserError) {
        console.error('[BROWSER] Cleanup close failed:', browserError.message);
      }
    }

    await cleanupAnonymousProxy();
    throw error;
  }
}

module.exports = { launchStealthBrowser };
