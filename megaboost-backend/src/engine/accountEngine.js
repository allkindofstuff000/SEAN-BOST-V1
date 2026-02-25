const puppeteer = require("puppeteer");
const Account = require("../model/Account");
let proxyChain;

try {
  proxyChain = require("proxy-chain");
} catch (error) {
  proxyChain = null;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const BROWSER_LAUNCH_RETRY_DELAYS_MS = [500, 1500, 4000];
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60000;
const DEFAULT_ACTION_TIMEOUT_MS = 30000;
const MIN_PROXY_PORT = 1;
const MAX_PROXY_PORT = 65535;
const MIN_VIEWPORT_WIDTH = 800;
const MAX_VIEWPORT_WIDTH = 3840;
const MIN_VIEWPORT_HEIGHT = 600;
const MAX_VIEWPORT_HEIGHT = 2160;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumberInRange(value, fallback, min, max) {
  const parsed = toNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function normalizeProxyType(value) {
  return String(value || "http").trim().toLowerCase() === "socks5"
    ? "socks5"
    : "http";
}

function toBoolean(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function shouldDisableWebRtc(account) {
  return toBoolean(account.disableWebRtc, true);
}

function getHeadlessMode() {
  return toBoolean(process.env.PUPPETEER_HEADLESS, true);
}

function normalizeLocale(account) {
  const locale = String(account.locale || process.env.BROWSER_LOCALE || "en-US").trim();
  return locale || "en-US";
}

function normalizeTimezone(account) {
  const timezone = String(account.timezone || process.env.BROWSER_TIMEZONE || "").trim();
  return timezone || null;
}

function getViewport(account) {
  return {
    width: toNumberInRange(
      account.screenWidth,
      toNumber(process.env.BROWSER_DEFAULT_VIEWPORT_WIDTH, 1366),
      MIN_VIEWPORT_WIDTH,
      MAX_VIEWPORT_WIDTH
    ),
    height: toNumberInRange(
      account.screenHeight,
      toNumber(process.env.BROWSER_DEFAULT_VIEWPORT_HEIGHT, 768),
      MIN_VIEWPORT_HEIGHT,
      MAX_VIEWPORT_HEIGHT
    )
  };
}

function getLaunchMaxAttempts() {
  return toNumberInRange(
    process.env.BROWSER_LAUNCH_MAX_ATTEMPTS,
    3,
    1,
    5
  );
}

function getNavigationTimeoutMs() {
  return toNumberInRange(
    process.env.BROWSER_NAVIGATION_TIMEOUT_MS,
    DEFAULT_NAVIGATION_TIMEOUT_MS,
    5000,
    180000
  );
}

function getActionTimeoutMs() {
  return toNumberInRange(
    process.env.BROWSER_ACTION_TIMEOUT_MS,
    DEFAULT_ACTION_TIMEOUT_MS,
    3000,
    120000
  );
}

function getRetryDelayMs(attempt) {
  const index = Math.min(attempt - 1, BROWSER_LAUNCH_RETRY_DELAYS_MS.length - 1);
  const base = BROWSER_LAUNCH_RETRY_DELAYS_MS[index];
  return base + Math.floor(Math.random() * 250);
}

function isRetryableLaunchError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("target closed") ||
    message.includes("browser closed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("failed to launch")
  );
}

function inferEngineErrorType(error) {
  const message = String(error?.message || "").toLowerCase();

  if (!message) return "unknown";
  if (message.includes("proxy")) return "proxy_failed";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("login") || message.includes("captcha")) return "login_failed";
  return "unknown";
}

function toStructuredEngineError(error, fallbackMessage = "Engine failure") {
  const message = String(error?.message || fallbackMessage);
  const wrapped = new Error(message);
  wrapped.type = inferEngineErrorType(error);
  wrapped.originalError = error;
  return wrapped;
}

function attachProxyCleanup(browser, cleanupProxy) {
  let cleaned = false;
  const runCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await cleanupProxy();
    } catch (error) {
      console.error("[PROXY] Cleanup error:", error.message);
    }
  };

  const originalClose = browser.close.bind(browser);
  browser.close = async () => {
    try {
      if (browser.isConnected()) {
        await originalClose();
      }
    } finally {
      await runCleanup();
    }
  };

  browser.once("disconnected", () => {
    runCleanup().catch(() => {});
  });
}

async function resolveProxyConfig(account) {
  const host = String(account.proxyHost || "").trim();
  const port = Number(account.proxyPort);

  if (!host || !Number.isFinite(port)) {
    return {
      proxyServer: null,
      requiresPageAuthentication: false,
      credentials: null,
      cleanup: async () => {}
    };
  }

  if (port < MIN_PROXY_PORT || port > MAX_PROXY_PORT) {
    throw new Error(`Proxy port must be between ${MIN_PROXY_PORT} and ${MAX_PROXY_PORT}`);
  }

  const proxyType = normalizeProxyType(account.proxyType);
  const username = account.proxyUsername ? String(account.proxyUsername) : "";
  const password = account.proxyPassword ? String(account.proxyPassword) : "";
  const hasProxyAuth = Boolean(username && password);

  if (!hasProxyAuth) {
    return {
      proxyServer: `${proxyType}://${host}:${port}`,
      requiresPageAuthentication: false,
      credentials: null,
      cleanup: async () => {}
    };
  }

  if (!proxyChain) {
    if (proxyType === "http") {
      return {
        proxyServer: `http://${host}:${port}`,
        requiresPageAuthentication: true,
        credentials: { username, password },
        cleanup: async () => {}
      };
    }

    throw new Error("Authenticated SOCKS5 proxies require proxy-chain to be installed");
  }

  const encodedUsername = encodeURIComponent(username);
  const encodedPassword = encodeURIComponent(password);
  const proxyUrl = `${proxyType}://${encodedUsername}:${encodedPassword}@${host}:${port}`;
  const anonymizedProxyUrl = await proxyChain.anonymizeProxy(proxyUrl);

  return {
    proxyServer: anonymizedProxyUrl,
    requiresPageAuthentication: false,
    credentials: null,
    cleanup: async () => {
      await proxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true);
    }
  };
}

async function applyPageHardening(page, account, viewport) {
  const navigationTimeout = getNavigationTimeoutMs();
  const actionTimeout = getActionTimeoutMs();
  const locale = normalizeLocale(account);
  const language = locale.split(/[-_]/)[0] || "en";
  const userAgent = String(account.userAgent || DEFAULT_USER_AGENT).trim() || DEFAULT_USER_AGENT;

  page.setDefaultNavigationTimeout(navigationTimeout);
  page.setDefaultTimeout(actionTimeout);

  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    isLandscape: viewport.width >= viewport.height
  });

  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({
    "user-agent": userAgent,
    "accept-language": `${locale},${language};q=0.9`
  });

  const timezone = normalizeTimezone(account);
  if (timezone) {
    try {
      await page.emulateTimezone(timezone);
    } catch (error) {
      console.warn(`[BROWSER] Invalid timezone "${timezone}" for ${account.email}: ${error.message}`);
    }
  }

  if (shouldDisableWebRtc(account)) {
    await page.evaluateOnNewDocument(() => {
      const disableWindowProperty = (key) => {
        if (!(key in window)) return;
        try {
          Object.defineProperty(window, key, {
            configurable: true,
            enumerable: false,
            writable: false,
            value: undefined
          });
        } catch {}
      };

      disableWindowProperty("RTCPeerConnection");
      disableWindowProperty("webkitRTCPeerConnection");

      try {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          enumerable: false,
          get: () => undefined
        });
      } catch {}

      try {
        if ("getUserMedia" in navigator) {
          Object.defineProperty(navigator, "getUserMedia", {
            configurable: true,
            enumerable: false,
            value: undefined
          });
        }
        if ("webkitGetUserMedia" in navigator) {
          Object.defineProperty(navigator, "webkitGetUserMedia", {
            configurable: true,
            enumerable: false,
            value: undefined
          });
        }
      } catch {}
    });
  }
}

async function launchBrowser(account) {
  const maxAttempts = getLaunchMaxAttempts();
  const viewport = getViewport(account);
  const locale = normalizeLocale(account);
  const disableWebRtc = shouldDisableWebRtc(account);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let browser = null;
    let proxyConfig = {
      proxyServer: null,
      requiresPageAuthentication: false,
      credentials: null,
      cleanup: async () => {}
    };

    try {
      proxyConfig = await resolveProxyConfig(account);

      const launchArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--mute-audio",
        `--window-size=${viewport.width},${viewport.height}`,
        `--lang=${locale}`
      ];

      if (disableWebRtc) {
        launchArgs.push(
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--webrtc-ip-private-network-policy=disable_non_proxied_udp"
        );
      }

      if (proxyConfig.proxyServer) {
        launchArgs.push(`--proxy-server=${proxyConfig.proxyServer}`);
      }

      browser = await puppeteer.launch({
        headless: getHeadlessMode(),
        args: launchArgs,
        ignoreHTTPSErrors: true
      });
      attachProxyCleanup(browser, proxyConfig.cleanup);

      const page = await browser.newPage();

      if (proxyConfig.requiresPageAuthentication && proxyConfig.credentials) {
        await page.authenticate(proxyConfig.credentials);
      }

      await applyPageHardening(page, account, viewport);
      return { browser, page };
    } catch (error) {
      lastError = error;

      if (browser) {
        try {
          await browser.close();
        } catch {}
      } else {
        try {
          await proxyConfig.cleanup();
        } catch {}
      }

      if (attempt >= maxAttempts || !isRetryableLaunchError(error)) {
        throw toStructuredEngineError(error, "Browser launch failed");
      }

      const waitMs = getRetryDelayMs(attempt);
      console.warn(
        `[BROWSER] Launch attempt ${attempt} failed for ${account.email}: ${error.message}. Retrying in ${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }

  throw toStructuredEngineError(lastError, "Failed to launch browser");
}

function getWorkerManager() {
  return require("./worker");
}

function normalizeUserId(userId) {
  if (!userId) return "";
  return String(userId).trim();
}

function normalizeAccountId(accountOrId) {
  if (!accountOrId) return "";
  if (typeof accountOrId === "string") return accountOrId.trim();
  return String(accountOrId._id || accountOrId.id || "").trim();
}

function getWorkerKey(userId, accountId) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedUserId || !normalizedAccountId) return "";
  return `${normalizedUserId}:${normalizedAccountId}`;
}

const workers = new Map();

class AccountEngine {
  async start(accountOrId, options = {}) {
    const workerManager = getWorkerManager();
    const accountId = normalizeAccountId(accountOrId);
    if (!accountId) return null;
    const scopedUserId = normalizeUserId(
      options?.userId ||
        (typeof accountOrId === "object" && accountOrId ? accountOrId.userId : "")
    );
    const workerKey = getWorkerKey(scopedUserId, accountId);

    if (
      (workerKey && workers.has(workerKey)) ||
      (accountId && workerManager.isRunning(accountId, { userId: scopedUserId }))
    ) {
      console.warn(`[WORKER] Account already running, skipping: ${accountId}`);
      return null;
    }

    const scopedAccount =
      accountOrId && typeof accountOrId === "object" && accountOrId._id
        ? accountOrId
        : await Account.findOne(
            scopedUserId
              ? {
                  _id: accountId,
                  userId: scopedUserId
                }
              : { _id: accountId }
          );
    if (!scopedAccount) {
      return null;
    }

    const result = await workerManager.requestStart(scopedAccount, {
      ...options,
      userId: scopedUserId || scopedAccount.userId
    });

    const nextKey = getWorkerKey(scopedUserId || scopedAccount.userId, accountId);
    if (nextKey) {
      workers.set(nextKey, {
        accountId: String(accountId),
        userId: normalizeUserId(scopedUserId || scopedAccount.userId)
      });
    }

    return result;
  }

  async stop(accountId, options = {}) {
    const scopedAccountId = normalizeAccountId(accountId);
    if (!scopedAccountId) return null;
    const scopedUserId = normalizeUserId(options?.userId);
    const account = await Account.findOne(
      scopedUserId
        ? {
            _id: scopedAccountId,
            userId: scopedUserId
          }
        : { _id: scopedAccountId }
    )
      .select("_id userId")
      .lean();
    if (!account && scopedUserId) {
      return null;
    }

    const resolvedUserId = normalizeUserId(account?.userId || scopedUserId);
    const key = getWorkerKey(resolvedUserId, scopedAccountId);
    if (key) {
      workers.delete(key);
    }

    return getWorkerManager().requestStop(scopedAccountId, {
      ...options,
      userId: resolvedUserId
    });
  }

  isRunning(accountId, options = {}) {
    const scopedAccountId = normalizeAccountId(accountId);
    if (!scopedAccountId) return false;
    const scopedUserId = normalizeUserId(options?.userId);
    const key = getWorkerKey(scopedUserId, scopedAccountId);
    if (key && workers.has(key)) {
      return true;
    }
    return getWorkerManager().isRunning(scopedAccountId, {
      userId: scopedUserId
    });
  }

  async startAll(accounts = [], options = {}) {
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop
      await this.start(account, {
        ...options,
        userId: options?.userId || account?.userId
      });
    }
    return true;
  }

  async stopAll(options = {}) {
    const scopedUserId = normalizeUserId(options?.userId);
    if (scopedUserId) {
      for (const key of Array.from(workers.keys())) {
        if (key.startsWith(`${scopedUserId}:`)) {
          workers.delete(key);
        }
      }
    } else {
      workers.clear();
    }
    return getWorkerManager().stopAll(options);
  }

  getWorkerStatus(options = {}) {
    return getWorkerManager().getWorkerStatus(options);
  }
}

const engine = new AccountEngine();
module.exports = engine;
module.exports.launchBrowser = launchBrowser;
