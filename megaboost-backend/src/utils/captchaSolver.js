/**
 * 2Captcha Integration Module
 * 
 * This module handles automatic captcha solving using the 2Captcha API.
 * 
 * 2Captcha API Documentation: https://2captcha.com/2captcha-api
 * 
 * Configuration (via environment variables):
 * - TWOCAPTCHA_API_KEY: Your 2Captcha API key
 * - TWOCAPTCHA_TIMEOUT: Max wait time for captcha solution (default: 120000ms = 2 minutes)
 * - TWOCAPTCHA_POLLTIME: Time between polling requests (default: 5000ms = 5 seconds)
 */

const https = require('https');
const { URL } = require('url');

// Default configuration
const DEFAULT_TIMEOUT = 120000; // 2 minutes
const DEFAULT_POLL_TIME = 5000; // 5 seconds

/**
 * Get 2Captcha configuration from environment
 */
function getConfig() {
  return {
    apiKey: process.env.TWOCAPTCHA_API_KEY,
    timeout: parseInt(process.env.TWOCAPTCHA_TIMEOUT || DEFAULT_TIMEOUT, 10),
    pollTime: parseInt(process.env.TWOCAPTCHA_POLLTIME || DEFAULT_POLL_TIME, 10),
  };
}

/**
 * Make HTTP GET request to 2Captcha API
 * @param {string} urlString - The URL to request
 * @returns {Promise<string>} - Response body as string
 */
function httpGet(urlString) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlString);
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'MegaBoost/1.0 (2Captcha Client)',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Submit captcha image to 2Captcha for solving
 * @param {string} captchaUrl - URL of the captcha image
 * @returns {Promise<string>} - Captcha ID for polling
 */
async function submitCaptcha(captchaUrl) {
  const config = getConfig();
  
  if (!config.apiKey) {
    throw new Error('2Captcha API key not configured. Set TWOCAPTCHA_API_KEY in environment.');
  }

  // Build the submission URL
  const submitUrl = new URL('https://2captcha.com/in.php');
  submitUrl.searchParams.set('key', config.apiKey);
  submitUrl.searchParams.set('method', 'url');
  submitUrl.searchParams.set('body', captchaUrl);
  submitUrl.searchParams.set('json', '1');

  console.log('[2Captcha] Submitting captcha for solving...');
  console.log('[2Captcha] Captcha URL:', captchaUrl);

  const response = await httpGet(submitUrl.toString());
  
  try {
    const result = JSON.parse(response);
    
    if (result.status === 1) {
      console.log('[2Captcha] Captcha submitted successfully. ID:', result.request);
      return result.request;
    } else {
      // Handle error codes
      const errorCodes = {
        'ERROR_KEY_DOES_NOT_EXIST': 'Invalid API key',
        'ERROR_ZERO_BALANCE': 'Insufficient balance',
        'ERROR_NO_SLOT_AVAILABLE': 'No workers available, try again later',
        'ERROR_CAPTCHA_UNSOLVABLE': 'Captcha could not be solved',
        'IP_BANNED': 'Your IP has been banned',
        'ERROR_ZERO_CAPTCHA_FILESIZE': 'Captcha URL not accessible (requires session). Use base64 method instead.',
      };
      
      const errorMessage = errorCodes[result.request] || `Submission failed: ${result.request}`;
      throw new Error(`[2Captcha] ${errorMessage}`);
    }
  } catch (parseError) {
    if (parseError.message.includes('[2Captcha]')) {
      throw parseError;
    }
    throw new Error(`[2Captcha] Failed to parse response: ${parseError.message}`);
  }
}

/**
 * Submit captcha as base64 image to 2Captcha for solving
 * @param {string} base64Image - Base64 encoded image (with or without data URI prefix)
 * @returns {Promise<string>} - Captcha ID for polling
 */
async function submitCaptchaBase64(base64Image) {
  const config = getConfig();
  
  if (!config.apiKey) {
    throw new Error('2Captcha API key not configured. Set TWOCAPTCHA_API_KEY in environment.');
  }

  // Remove data URI prefix if present
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

  // Build the submission URL
  const submitUrl = new URL('https://2captcha.com/in.php');
  submitUrl.searchParams.set('key', config.apiKey);
  submitUrl.searchParams.set('method', 'base64');
  submitUrl.searchParams.set('body', base64Data);
  submitUrl.searchParams.set('json', '1');

  console.log('[2Captcha] Submitting captcha as base64 for solving...');

  const response = await httpGet(submitUrl.toString());
  
  try {
    const result = JSON.parse(response);
    
    if (result.status === 1) {
      console.log('[2Captcha] Captcha submitted successfully. ID:', result.request);
      return result.request;
    } else {
      // Handle error codes
      const errorCodes = {
        'ERROR_KEY_DOES_NOT_EXIST': 'Invalid API key',
        'ERROR_ZERO_BALANCE': 'Insufficient balance',
        'ERROR_NO_SLOT_AVAILABLE': 'No workers available, try again later',
        'ERROR_CAPTCHA_UNSOLVABLE': 'Captcha could not be solved',
        'IP_BANNED': 'Your IP has been banned',
      };
      
      const errorMessage = errorCodes[result.request] || `Submission failed: ${result.request}`;
      throw new Error(`[2Captcha] ${errorMessage}`);
    }
  } catch (parseError) {
    if (parseError.message.includes('[2Captcha]')) {
      throw parseError;
    }
    throw new Error(`[2Captcha] Failed to parse response: ${parseError.message}`);
  }
}

/**
 * Poll for captcha solution
 * @param {string} captchaId - The captcha ID from submission
 * @param {number} timeout - Maximum time to wait in milliseconds
 * @param {number} pollTime - Time between polling attempts in milliseconds
 * @returns {Promise<string>} - The solved captcha text
 */
async function pollForSolution(captchaId, timeout, pollTime) {
  const startTime = Date.now();
  
  console.log('[2Captcha] Polling for solution...');

  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollTime));
    
    try {
      const statusUrl = new URL('https://2captcha.com/res.php');
      statusUrl.searchParams.set('key', process.env.TWOCAPTCHA_API_KEY);
      statusUrl.searchParams.set('action', 'get');
      statusUrl.searchParams.set('id', captchaId);
      statusUrl.searchParams.set('json', '1');

      const response = await httpGet(statusUrl.toString());
      const result = JSON.parse(response);

      if (result.status === 1) {
        console.log('[2Captcha] Solution received:', result.request);
        return result.request;
      }

      // Check for specific status codes
      if (result.request === 'CAPCHA_NOT_READY') {
        console.log('[2Captcha] Still processing...');
        continue;
      }

      // Handle error cases
      if (result.request === 'ERROR_CAPTCHA_UNSOLVABLE') {
        throw new Error('[2Captcha] Captcha could not be solved by workers');
      }
      
      if (result.request === 'ERROR') {
        throw new Error('[2Captcha] Unknown error occurred');
      }

      // If we get here and request is not 1, it's an error
      throw new Error(`[2Captcha] Unexpected response: ${result.request}`);
      
    } catch (error) {
      if (error.message.includes('[2Captcha]')) {
        throw error;
      }
      // Network errors, continue polling
      console.log('[2Captcha] Poll error, retrying:', error.message);
    }
  }

  throw new Error(`[2Captcha] Timeout after ${timeout}ms waiting for solution`);
}

/**
 * Solve captcha using 2Captcha API (URL method)
 * @param {string} captchaUrl - URL of the captcha image to solve
 * @returns {Promise<string>} - The solved captcha text
 */
async function solveCaptcha(captchaUrl) {
  if (!captchaUrl) {
    throw new Error('Captcha URL is required');
  }

  const config = getConfig();

  // Validate API key
  if (!config.apiKey) {
    throw new Error('2Captcha API key not configured. Please set TWOCAPTCHA_API_KEY in your .env file.');
  }

  console.log('[2Captcha] Starting captcha solve process...');
  console.log('[2Captcha] Configuration:', {
    timeout: config.timeout,
    pollTime: config.pollTime,
    hasApiKey: !!config.apiKey,
  });

  try {
    // Step 1: Submit the captcha
    const captchaId = await submitCaptcha(captchaUrl);
    
    // Step 2: Poll for the solution
    const solution = await pollForSolution(captchaId, config.timeout, config.pollTime);
    
    return solution;
    
  } catch (error) {
    console.error('[2Captcha] Error solving captcha:', error.message);
    throw error;
  }
}

/**
 * Solve captcha using 2Captcha API (Base64 method - for session-protected captchas)
 * @param {string} base64Image - Base64 encoded captcha image
 * @returns {Promise<string>} - The solved captcha text
 */
async function solveCaptchaBase64(base64Image) {
  if (!base64Image) {
    throw new Error('Base64 image is required');
  }

  const config = getConfig();

  // Validate API key
  if (!config.apiKey) {
    throw new Error('2Captcha API key not configured. Please set TWOCAPTCHA_API_KEY in your .env file.');
  }

  console.log('[2Captcha] Starting captcha solve process (base64 method)...');
  console.log('[2Captcha] Configuration:', {
    timeout: config.timeout,
    pollTime: config.pollTime,
    hasApiKey: !!config.apiKey,
  });

  try {
    // Step 1: Submit the captcha as base64
    const captchaId = await submitCaptchaBase64(base64Image);
    
    // Step 2: Poll for the solution
    const solution = await pollForSolution(captchaId, config.timeout, config.pollTime);
    
    return solution;
    
  } catch (error) {
    console.error('[2Captcha] Error solving captcha:', error.message);
    throw error;
  }
}

/**
 * Get account balance from 2Captcha
 * @returns {Promise<number>} - Account balance in USD
 */
async function getBalance() {
  const config = getConfig();
  
  if (!config.apiKey) {
    throw new Error('2Captcha API key not configured');
  }

  const balanceUrl = new URL('https://2captcha.com/res.php');
  balanceUrl.searchParams.set('key', config.apiKey);
  balanceUrl.searchParams.set('action', 'balance');
  balanceUrl.searchParams.set('json', '1');

  const response = await httpGet(balanceUrl.toString());
  const result = JSON.parse(response);

  if (result.status === 1) {
    return parseFloat(result.request);
  }

  throw new Error(`Failed to get balance: ${result.request}`);
}

/**
 * Report incorrect captcha solution to 2Captcha (for refund)
 * @param {string} captchaId - The captcha ID that was incorrectly solved
 * @returns {Promise<boolean>} - True if report was successful
 */
async function reportIncorrect(captchaId) {
  const config = getConfig();
  
  if (!config.apiKey) {
    throw new Error('2Captcha API key not configured');
  }

  const reportUrl = new URL('https://2captcha.com/res.php');
  reportUrl.searchParams.set('key', config.apiKey);
  reportUrl.searchParams.set('action', 'reportbad');
  reportUrl.searchParams.set('id', captchaId);
  reportUrl.searchParams.set('json', '1');

  const response = await httpGet(reportUrl.toString());
  const result = JSON.parse(response);

  if (result.status === 1) {
    console.log('[2Captcha] Incorrect captcha reported successfully');
    return true;
  }

  console.log('[2Captcha] Failed to report incorrect captcha:', result.request);
  return false;
}

/**
 * Check if 2Captcha is properly configured
 * @returns {boolean} - True if configured
 */
function isConfigured() {
  return !!process.env.TWOCAPTCHA_API_KEY;
}

module.exports = {
  solveCaptcha,
  solveCaptchaBase64,
  getBalance,
  reportIncorrect,
  isConfigured,
  getConfig,
};
