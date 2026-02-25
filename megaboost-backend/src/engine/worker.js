const fs = require("fs").promises;
const path = require("path");
const Account = require("../model/Account");
const { updateStatus } = require("./statusManager");
const { launchStealthBrowser } = require("./browserLauncher");
const {
  solveCaptcha,
  solveCaptchaBase64,
  isConfigured
} = require("../utils/captchaSolver");
const { logActivity } = require("../utils/activityLogger");
const { normalizeUserId } = require("../utils/socketEvents");
const {
  emitAccountUpdateEvent,
  emitToUserEvent
} = require("../internal/eventBridge");

const ROOT_URL = "https://megapersonals.eu";
const POSTS_LIST_URL = `${ROOT_URL}/users/posts/list`;
const LOGIN_URL =
  process.env.LOGIN_URL || `${ROOT_URL}/users/auth/login`;
const COOKIES_DIR = path.join(__dirname, "..", "..", "cookies");
const COOLDOWN_BUFFER_MS = Number(
  process.env.BUMP_COOLDOWN_BUFFER_MS || 2 * 60 * 1000
);
const COOLDOWN_MAX_WAIT_MS = Number(
  process.env.BUMP_COOLDOWN_MAX_WAIT_MS || 60 * 60 * 1000
);
const configuredMinPublishIntervalMinutes = Number(
  process.env.BUMP_MIN_INTERVAL_MINUTES || 15
);
const MIN_PUBLISH_INTERVAL_MINUTES = Number.isFinite(
  configuredMinPublishIntervalMinutes
)
  ? Math.max(15, configuredMinPublishIntervalMinutes)
  : 15;
const MIN_PUBLISH_INTERVAL_MS = Math.floor(
  MIN_PUBLISH_INTERVAL_MINUTES * 60 * 1000
);
const VERIFICATION_TIMEOUT_MS = Number(
  process.env.VERIFICATION_TIMEOUT_MS || 5 * 60 * 1000
);
const HEARTBEAT_INTERVAL_MS = Number(
  process.env.WORKER_HEARTBEAT_INTERVAL_MS || 10 * 1000
);
const HEARTBEAT_EMIT_INTERVAL_MS = Number(
  process.env.HEARTBEAT_EMIT_INTERVAL_MS || 30 * 1000
);
const HEARTBEAT_LOG_MIN_INTERVAL_MS = Number(
  process.env.HEARTBEAT_LOG_MIN_INTERVAL_MS || 10 * 60 * 1000
);
const HEARTBEAT_DETAIL_LOG_INTERVAL_MS = Number(
  process.env.HEARTBEAT_DETAIL_LOG_INTERVAL_MS || 60 * 1000
);
const HEARTBEAT_SUMMARY_INTERVAL_MS = Number(
  process.env.HEARTBEAT_SUMMARY_INTERVAL_MS || 10 * 60 * 1000
);
const DEBUG_HEARTBEAT_ENABLED = process.env.DEBUG_HEARTBEAT === "1";
const HEARTBEAT_RUNNING_STATUSES = new Set([
  "active",
  "running",
  "starting",
  "restarting",
  "awaiting_2fa",
  "awaiting_verification_code"
]);
const BANNED_MESSAGE_SELECTOR = ".banned-message-small";

function isPostsListUrl(url) {
  return String(url || "").includes("/users/posts/list");
}

function resolveProxyLabel(account, fallbackIp = "") {
  const host = String(account?.proxyHost || "").trim();
  const port = Number(account?.proxyPort);
  if (host && Number.isFinite(port) && port > 0) {
    return `${host}:${port}`;
  }
  if (host) {
    return host;
  }
  return String(fallbackIp || "").trim() || "unknown";
}

async function detectBannedState(page) {
  return page
    .evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) {
        return {
          banned: false,
          text: ""
        };
      }

      const text = String(node.innerText || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);

      return {
        banned: true,
        text
      };
    }, BANNED_MESSAGE_SELECTOR)
    .catch(() => ({
      banned: false,
      text: ""
    }));
}

function isLoginUrl(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("/users/auth/login") || value.includes("/users/login");
}

const LOGIN_SELECTORS = {
  email:
    process.env.USER_SELECTOR ||
    "#email, input[name='email'], input[name='username'], input[type='email']",
  password:
    process.env.PASS_SELECTOR ||
    "#password, input[name='password'], input[type='password']",
  captchaImage:
    process.env.CAPTCHA_IMG_SELECTOR ||
    "#captcha_image_itself, img.captcha, img[src*='captcha']",
  captchaInput:
    process.env.CAPTCHA_INPUT_SELECTOR ||
    "#captcha_code, input[name='captcha'], input[placeholder*='code']",
  submit:
    process.env.SUBMIT_SELECTOR ||
    "#submit, #login_submit, button[type='submit'], input[type='submit'], input[type='button'][value*='submit' i], button[id*='submit' i], input[id*='submit' i], button[name='submit'], input[name='submit']"
};

const BACKOFF_BASE_MS = 15000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const BACKOFF_JITTER_MS = 5000;
const FAILURE_LIMIT = 5;
const MAX_CONCURRENCY = (() => {
  const parsed = Number(process.env.MAX_CONCURRENCY || 8);
  if (!Number.isFinite(parsed) || parsed < 1) return 8;
  return Math.floor(parsed);
})();
const RECOVERY_INTERVAL_MS = (() => {
  const parsed = Number(process.env.WORKER_RECOVERY_INTERVAL_MS || 30000);
  if (!Number.isFinite(parsed) || parsed < 0) return 30000;
  return Math.floor(parsed);
})();
const STALE_START_RECOVERY_MS = (() => {
  const parsed = Number(
    process.env.WORKER_STALE_START_RECOVERY_MS || 2 * 60 * 1000
  );
  if (!Number.isFinite(parsed) || parsed < 0) return 2 * 60 * 1000;
  return Math.floor(parsed);
})();

const runningWorkers = new Map();
const startingLocks = new Set();
const startQueue = [];
const queuedAccounts = new Set();
const retryTimers = new Map();
const stopRequests = new Set();
const heartbeatDebugLastPrintedAt = new Map();
const heartbeatByAccountId = new Map();
let heartbeatSummaryTimer = null;
let recoveryTimer = null;
let recoveryInProgress = false;
const WORKER_KEY_SEPARATOR = ":";

// Pending verification sessions map
const pendingVerificationSessions = new Map();

function buildWorkerKey(userId, accountId) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) return "";
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return normalizedAccountId;
  return `${normalizedUserId}${WORKER_KEY_SEPARATOR}${normalizedAccountId}`;
}

function parseAccountIdFromWorkerKey(workerKey) {
  const value = String(workerKey || "").trim();
  if (!value) return "";
  const separatorIndex = value.lastIndexOf(WORKER_KEY_SEPARATOR);
  if (separatorIndex < 0) return value;
  return value.slice(separatorIndex + 1);
}

function parseUserIdFromWorkerKey(workerKey) {
  const value = String(workerKey || "").trim();
  if (!value) return "";
  const separatorIndex = value.lastIndexOf(WORKER_KEY_SEPARATOR);
  if (separatorIndex < 0) return "";
  return value.slice(0, separatorIndex);
}

function findRunningWorkerKey(accountOrId, options = {}) {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return "";

  const scopedUserId = normalizeUserId(
    options?.userId ||
      (typeof accountOrId === "object" ? accountOrId.userId : "")
  );
  const scopedKey = buildWorkerKey(scopedUserId, accountId);
  if (scopedKey && runningWorkers.has(scopedKey)) {
    return scopedKey;
  }

  if (scopedUserId) {
    for (const key of runningWorkers.keys()) {
      if (parseAccountIdFromWorkerKey(key) !== accountId) continue;
      if (parseUserIdFromWorkerKey(key) === scopedUserId) {
        return key;
      }
    }
    return "";
  }

  if (runningWorkers.has(accountId)) {
    return accountId;
  }

  for (const key of runningWorkers.keys()) {
    if (parseAccountIdFromWorkerKey(key) === accountId) {
      return key;
    }
  }

  return "";
}

function hasRunningWorker(accountOrId, options = {}) {
  return Boolean(findRunningWorkerKey(accountOrId, options));
}

function getRunningWorkerEntry(accountOrId, options = {}) {
  const key = findRunningWorkerKey(accountOrId, options);
  if (!key) return null;
  return {
    key,
    entry: runningWorkers.get(key)
  };
}

function setRunningWorker(account, worker, extra = {}) {
  const accountId = normalizeAccountId(account);
  if (!accountId) return "";
  const userId = normalizeUserId(account?.userId);
  const workerKey = buildWorkerKey(userId, accountId);
  runningWorkers.set(workerKey, {
    worker,
    accountId,
    userId,
    ...extra
  });
  return workerKey;
}

function deleteRunningWorker(accountOrId, options = {}) {
  const key = findRunningWorkerKey(accountOrId, options);
  if (!key) return false;
  return runningWorkers.delete(key);
}

function getRunningAccountIds(options = {}) {
  const scopedUserId = normalizeUserId(options?.userId);
  const ids = [];

  for (const [key, entry] of runningWorkers.entries()) {
    const entryUserId = normalizeUserId(entry?.userId || parseUserIdFromWorkerKey(key));
    if (scopedUserId) {
      if (!entryUserId || entryUserId !== scopedUserId) {
        continue;
      }
    }
    ids.push(String(entry?.accountId || parseAccountIdFromWorkerKey(key)));
  }

  return ids;
}

function createEmptyHeartbeatTotals() {
  return {
    bumping: 0,
    cooldown: 0,
    running: 0,
    stopped: 0,
    blocked: 0
  };
}

function getHeartbeatStatusBucket(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "bumping") return "bumping";
  if (value === "waiting_cooldown") return "cooldown";
  if (value === "stopped") return "stopped";
  if (value === "blocked") return "blocked";
  if (HEARTBEAT_RUNNING_STATUSES.has(value)) return "running";
  return "";
}

async function emitHeartbeatSummary() {
  const totals = createEmptyHeartbeatTotals();

  try {
    const accounts = await Account.find({}, "status").lean();
    for (const account of accounts) {
      const bucket = getHeartbeatStatusBucket(account?.status);
      if (bucket) {
        totals[bucket] += 1;
      }
    }
  } catch (error) {
    console.error("[HEARTBEAT] Summary failed:", error.message);
    return;
  }

  const memoryUsageMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
  console.log(
    `[HEARTBEAT] totals: bumping=${totals.bumping} cooldown=${totals.cooldown} running=${totals.running} stopped=${totals.stopped} blocked=${totals.blocked} queued=${startQueue.length} memMB=${memoryUsageMb}`
  );
}

function startHeartbeatSummaryLogger() {
  if (!DEBUG_HEARTBEAT_ENABLED) {
    return;
  }

  if (heartbeatSummaryTimer) {
    return;
  }

  heartbeatSummaryTimer = setInterval(() => {
    emitHeartbeatSummary().catch((error) => {
      console.error("[HEARTBEAT] Summary timer failed:", error.message);
    });
  }, HEARTBEAT_SUMMARY_INTERVAL_MS);

  if (typeof heartbeatSummaryTimer.unref === "function") {
    heartbeatSummaryTimer.unref();
  }
}

startHeartbeatSummaryLogger();

function startRecoveryLoop() {
  if (recoveryTimer || RECOVERY_INTERVAL_MS <= 0) {
    return;
  }

  const runRecovery = () => {
    recoverOverdueAccounts().catch((error) => {
      console.error("[RECOVERY] Timer failed:", error.message);
    });
  };

  recoveryTimer = setInterval(runRecovery, RECOVERY_INTERVAL_MS);
  if (typeof recoveryTimer.unref === "function") {
    recoveryTimer.unref();
  }

  const kickoffTimer = setTimeout(runRecovery, 5000);
  if (typeof kickoffTimer.unref === "function") {
    kickoffTimer.unref();
  }
}

function clearPendingVerificationSession(accountId) {
  const key = String(accountId);
  const session = pendingVerificationSessions.get(key);
  if (session?.expiryTimer) clearTimeout(session.expiryTimer);
  pendingVerificationSessions.delete(key);
}

function getCurrentMinutesForTimezone(timezone) {
  const now = new Date();
  const normalizedTimezone = String(timezone || "").trim();
  if (!normalizedTimezone) {
    return now.getHours() * 60 + now.getMinutes();
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: normalizedTimezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    }).formatToParts(now);

    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      throw new Error("Invalid timezone hour/minute parts");
    }

    return hour * 60 + minute;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function isWithinRuntimeWindow(windowString, timezone = "") {
  if (!windowString) return true;

  const [start, end] = windowString.split("-");
  if (!start || !end) return true;

  const currentMinutes = getCurrentMinutesForTimezone(timezone);

  const [startHour, startMin] = start.split(":").map(Number);
  const [endHour, endMin] = end.split(":").map(Number);

  if (
    !Number.isFinite(startHour) ||
    !Number.isFinite(startMin) ||
    !Number.isFinite(endHour) ||
    !Number.isFinite(endMin)
  ) {
    return true;
  }

  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

async function ensureCookiesDir() {
  await fs.mkdir(COOKIES_DIR, { recursive: true });
}

function getCookieFilePath(account) {
  return path.join(COOKIES_DIR, `${account._id}.json`);
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseSelfTestPattern(patternValue) {
  const raw = String(patternValue || "")
    .split(",")
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);

  const normalized = raw
    .map((entry) => {
      if (entry === "cooldown" || entry === "wait") return "cooldown";
      if (entry === "success" || entry === "ok") return "success";
      if (entry === "error" || entry === "fail") return "error";
      return null;
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    return ["success", "cooldown", "success"];
  }

  return normalized;
}

function getSelfTestConfig(account) {
  const envEnabled = toBoolean(process.env.WORKER_BUMP_SELF_TEST_MODE, false);
  const accountEnabled = toBoolean(
    account?.bumpSelfTestMode ?? account?.selfTestMode,
    false
  );

  const enabled = envEnabled || accountEnabled;
  const maxCyclesRaw = Math.floor(
    toNumber(process.env.WORKER_BUMP_SELF_TEST_CYCLES, 5)
  );
  const maxCycles = maxCyclesRaw < 0 ? 0 : maxCyclesRaw;

  return {
    enabled,
    maxCycles,
    successDelayMs: Math.max(
      1000,
      Math.floor(toNumber(process.env.WORKER_BUMP_SELF_TEST_SUCCESS_DELAY_MS, 8000))
    ),
    cooldownDelayMs: Math.max(
      1000,
      Math.floor(toNumber(process.env.WORKER_BUMP_SELF_TEST_COOLDOWN_MS, 12000))
    ),
    errorRetryDelayMs: Math.max(
      1000,
      Math.floor(toNumber(process.env.WORKER_BUMP_SELF_TEST_ERROR_RETRY_MS, 6000))
    ),
    pattern: parseSelfTestPattern(process.env.WORKER_BUMP_SELF_TEST_PATTERN)
  };
}

function normalizeBumpConfig(account) {
  const baseInterval = Math.max(1, toNumber(account.baseInterval, 30));
  const randomMin = Math.max(0, toNumber(account.randomMin, 0));
  const randomMax = Math.max(randomMin, toNumber(account.randomMax, randomMin));
  const maxDailyRuntime = Math.max(1, toNumber(account.maxDailyRuntime, 8));
  const maxDailyBumpsRaw = toNumber(account.maxDailyBumps, 100);
  const maxDailyBumps = Number.isFinite(maxDailyBumpsRaw)
    ? Math.max(1, maxDailyBumpsRaw)
    : 100;

  return {
    baseInterval,
    randomMin,
    randomMax,
    maxDailyRuntime,
    maxDailyBumps
  };
}

function normalizeAccountId(accountOrId) {
  if (!accountOrId) return "";
  if (typeof accountOrId === "string") return accountOrId;
  return String(accountOrId._id || accountOrId.id || "");
}

function getSafePageUrl(page) {
  try {
    if (!page || typeof page.isClosed !== "function" || page.isClosed()) {
      return "";
    }
    return String(page.url() || "");
  } catch {
    return "";
  }
}

function setWorkerStep(state, step, page) {
  if (!state) return;
  state.currentStep = String(step || "");
  const url = getSafePageUrl(page);
  if (url) {
    state.currentUrl = url;
  }
}

async function assertAccountNotBanned(page, account, state, options = {}) {
  if (!page || page.isClosed()) {
    return;
  }

  if (state?.bannedHandled) {
    throw createWorkerError("banned", `Account banned detected for ${account.email}`);
  }

  const bannedProbe = await detectBannedState(page);
  if (!bannedProbe?.banned) {
    return;
  }

  if (state) {
    state.bannedHandled = true;
    state.currentStatus = "banned";
    setWorkerStep(state, "banned_detected", page);
  }

  const ip = options?.ip || "";
  const proxy = resolveProxyLabel(account, options?.proxyIp || ip);
  const reason = String(options?.reason || "banned_message_detected");
  const currentUrl = getSafePageUrl(page);
  const message = `Account ${account.email} was banned through IP ${proxy}`;

  console.error(`[BANNED] ${message}`);
  if (bannedProbe.text) {
    console.error(`[BANNED] Matched text: ${bannedProbe.text}`);
  }

  await Account.findByIdAndUpdate(account._id, {
    status: "banned",
    waitingUntil: null,
    nextBumpAt: null,
    nextBumpDelayMs: null
  }).catch(() => null);

  await updateStatus(account._id, "banned", {
    ip,
    email: account.email,
    metadata: {
      reason,
      proxy,
      url: currentUrl
    }
  }).catch(() => null);

  await logActivity({
    level: "error",
    message,
    ip,
    email: account.email,
    accountId: account._id,
    metadata: {
      reason,
      proxy,
      url: currentUrl,
      matchedSelector: BANNED_MESSAGE_SELECTOR,
      bannedMessage: bannedProbe.text || undefined
    }
  }).catch(() => null);

  const eventPayload = {
    type: "account_banned",
    accountId: String(account._id),
    userId: String(account.userId || ""),
    email: account.email,
    proxy,
    reason,
    url: currentUrl,
    timestamp: new Date().toISOString()
  };
  await emitToUserEvent(account.userId, "account:banned", eventPayload).catch(() => null);
  await emitToUserEvent(account.userId, "account:event", eventPayload).catch(() => null);
  emitAccountUpdate(account, {
    status: "banned",
    waitingUntil: null,
    nextBumpAt: null,
    nextBumpDelayMs: null
  });

  throw createWorkerError("banned", `Account banned detected for ${account.email}`);
}

async function emitWorkerHeartbeat(account, state, page) {
  if (!account || !state || state.stopped) return;

  const accountId = normalizeAccountId(account);
  if (!accountId) return;

  const nowMs = Date.now();
  const ts = new Date().toISOString();
  const mem = process.memoryUsage();
  const currentUrl = getSafePageUrl(page) || state.currentUrl || "";
  const status = String(state.currentStatus || account.status || "running");
  const step = String(state.currentStep || "idle");
  const stateKey = `${status}::${step}`;

  const beat = {
    workerRunning: true,
    accountId,
    status,
    step,
    currentUrl: currentUrl || undefined,
    mem,
    timestamp: ts
  };

  const lastBeat = heartbeatByAccountId.get(accountId) || {
    lastSocketEmitAt: 0,
    lastDbLogAt: 0,
    lastStateKey: ""
  };
  const stateChanged = lastBeat.lastStateKey !== stateKey;

  heartbeatByAccountId.set(accountId, {
    ...lastBeat,
    beat
  });

  if (nowMs - lastBeat.lastSocketEmitAt >= HEARTBEAT_EMIT_INTERVAL_MS) {
    await emitToUserEvent(account.userId, "worker:heartbeat", {
      ...beat,
      userId: String(account.userId || "")
    }).catch(() => null);

    lastBeat.lastSocketEmitAt = nowMs;
  }

  if (stateChanged || nowMs - lastBeat.lastDbLogAt >= HEARTBEAT_LOG_MIN_INTERVAL_MS) {
    await logActivity({
      level: "info",
      message: `Heartbeat ${status}/${step}: ${account.email}`,
      email: account.email,
      accountId: account._id,
      metadata: {
        status,
        step,
        url: currentUrl || undefined,
        workerRunning: true
      }
    }).catch(() => null);

    lastBeat.lastDbLogAt = nowMs;
  }

  lastBeat.lastStateKey = stateKey;
  heartbeatByAccountId.set(accountId, {
    ...lastBeat,
    beat
  });

  if (DEBUG_HEARTBEAT_ENABLED) {
    const lastPrintedAt = Number(heartbeatDebugLastPrintedAt.get(accountId) || 0);
    if (nowMs - lastPrintedAt >= HEARTBEAT_DETAIL_LOG_INTERVAL_MS) {
      heartbeatDebugLastPrintedAt.set(accountId, nowMs);
      console.debug(
        `[HEARTBEAT] ${account.email} ${beat.status}/${beat.step}`,
        beat.currentUrl || ""
      );
    }
  }
}

function stopWorkerHeartbeat(accountOrId, state) {
  const accountId = normalizeAccountId(accountOrId);
  if (accountId) {
    heartbeatDebugLastPrintedAt.delete(accountId);
    heartbeatByAccountId.delete(accountId);
  }

  if (state?.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function startWorkerHeartbeat(account, state, page) {
  stopWorkerHeartbeat(account, state);

  const tick = () => {
    emitWorkerHeartbeat(account, state, page).catch((error) => {
      console.error(
        `[HEARTBEAT] Emit failed for ${account?.email || "unknown"}:`,
        error.message
      );
    });
  };

  state.heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  tick();
}

function isTwoFactorUrl(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("/device-verification") || value.includes("/verification");
}

function isVerificationSuccessUrl(url) {
  const value = String(url || "").toLowerCase();
  return (
    value.includes("/users/device-verification/successful/") ||
    value.includes("/users/device-verification/success")
  );
}

function isPhoneVerificationUrl(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("/phone/verification/verify/");
}

function createWorkerError(type, message, originalError) {
  const error = new Error(message || "Worker failed");
  error.type = String(type || "unknown");
  if (originalError) {
    error.originalError = originalError;
  }
  return error;
}

function inferWorkerErrorType(message) {
  const text = String(message || "").toLowerCase();

  if (!text) return "unknown";
  if (text.includes("banned")) return "banned";
  if (text.includes("acc pass wrong") || text.includes("error=t")) {
    return "credentials_invalid";
  }
  if (text.includes("verification") || text.includes("2fa")) return "awaiting_2fa";
  if (text.includes("proxy")) return "proxy_failed";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (
    text.includes("login") ||
    text.includes("captcha") ||
    text.includes("session validation")
  ) {
    return "login_failed";
  }

  return "unknown";
}

function normalizeWorkerError(error) {
  if (!error) {
    return {
      type: "unknown",
      message: "Worker failed with unknown error"
    };
  }

  const message = String(error.message || "Worker failed with unknown error");
  const type = String(error.type || inferWorkerErrorType(message) || "unknown");
  return { type, message };
}

function mapErrorTypeToStatus(type) {
  if (type === "login_failed") return "login_failed";
  if (type === "credentials_invalid") return "login_failed";
  if (type === "proxy_failed") return "proxy_failed";
  if (type === "banned") return "banned";
  if (type === "awaiting_2fa") return "awaiting_2fa";
  return "error";
}

function calculateRetryDelayMs(failureCount) {
  const attempt = Math.max(1, Number(failureCount) || 1);
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS);
  const jitter = Math.floor(Math.random() * (BACKOFF_JITTER_MS + 1));
  return delay + jitter;
}

function clearRetryTimer(accountId) {
  const key = String(accountId);
  const retryTimer = retryTimers.get(key);
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimers.delete(key);
  }
}

function removeFromQueue(accountId, options = {}) {
  const key = String(accountId);
  const userId = normalizeUserId(options?.userId);
  const scopedQueueKey = buildWorkerKey(userId, key);
  queuedAccounts.delete(scopedQueueKey);
  queuedAccounts.delete(key);

  for (let index = startQueue.length - 1; index >= 0; index -= 1) {
    const item = startQueue[index];
    if (!item || item.accountId !== key) continue;
    if (userId && normalizeUserId(item.userId) !== userId) continue;
    startQueue.splice(index, 1);
  }
}

function queueStart(accountId, options = {}) {
  const key = String(accountId);
  if (!key) return false;

  const userId = normalizeUserId(options?.userId);
  const queueKey = buildWorkerKey(userId, key);
  if (queuedAccounts.has(queueKey)) return false;

  startQueue.push({
    accountId: key,
    userId,
    queueKey,
    ip: options.ip || ""
  });
  queuedAccounts.add(queueKey);
  return true;
}

async function updateWorkerState(accountId, workerStatePatch = {}, accountPatch = {}) {
  const set = {};

  Object.entries(workerStatePatch).forEach(([key, value]) => {
    set[`workerState.${key}`] = value;
  });

  Object.entries(accountPatch).forEach(([key, value]) => {
    set[key] = value;
  });

  if (Object.keys(set).length === 0) {
    return;
  }

  await Account.findByIdAndUpdate(accountId, { $set: set }).catch(() => null);
}

function emitAccountUpdate(accountOrId, patch = {}, extra = {}, userId = "") {
  emitAccountUpdateEvent(accountOrId, patch, extra, userId).catch(() => null);
}

function buildPendingConnectionTest(connectionTest) {
  if (connectionTest && typeof connectionTest === "object") {
    if (connectionTest.testedAt) {
      return connectionTest;
    }
  }

  return {
    success: false,
    testedAt: null,
    error: null,
    status: "pending"
  };
}

function clearStopRequest(accountId) {
  stopRequests.delete(String(accountId));
}

function isStopRequested(accountId) {
  return stopRequests.has(String(accountId));
}

function isRunning(accountOrId, options = {}) {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return false;
  return hasRunningWorker(accountOrId, options) || startingLocks.has(accountId);
}

async function findFirstElement(page, selectorGroup, { timeout = 0 } = {}) {
  const selectors = String(selectorGroup || "")
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);

  for (const selector of selectors) {
    try {
      if (timeout > 0) {
        await page.waitForSelector(selector, {
          visible: true,
          timeout
        });
      }

      const element = await page.$(selector);
      if (element) {
        return { element, selector };
      }
    } catch {
      // Try next selector.
    }
  }

  return { element: null, selector: null };
}

async function solveCaptchaFromPage(page, captchaElement) {
  if (!isConfigured()) {
    throw new Error(
      "Captcha solver is not configured. Set TWOCAPTCHA_API_KEY first."
    );
  }

  let solvedCaptcha = "";

  const box = await captchaElement.boundingBox();
  if (box?.width && box?.height) {
    const screenshotBase64 = await page.screenshot({
      encoding: "base64",
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.max(1, box.width),
        height: Math.max(1, box.height)
      }
    });

    if (screenshotBase64) {
      solvedCaptcha = await solveCaptchaBase64(
        `data:image/png;base64,${screenshotBase64}`
      );
    }
  }

  if (!solvedCaptcha) {
    const rawSrc = await page.evaluate(
      (node) => node.getAttribute("src") || "",
      captchaElement
    );
    const captchaUrl = rawSrc ? new URL(rawSrc, page.url()).href : "";

    if (!captchaUrl) {
      throw new Error("Captcha image found but URL is empty.");
    }

    solvedCaptcha = await solveCaptcha(captchaUrl);
  }

  return String(solvedCaptcha || "").trim();
}

async function saveCookies(page, account) {
  const cookies = await page.cookies();
  await ensureCookiesDir();
  await fs.writeFile(
    getCookieFilePath(account),
    JSON.stringify(cookies, null, 2),
    "utf8"
  );
  await Account.findByIdAndUpdate(account._id, {
    cookiesSavedAt: new Date()
  });
  console.log(`[COOKIES] Cookies saved for ${account.email} (${cookies.length})`);
}

async function loadCookies(page, account) {
  try {
    await ensureCookiesDir();
    const raw = await fs.readFile(getCookieFilePath(account), "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      console.log(`[COOKIES] No cookie file found for ${account.email}`);
      return false;
    }

    await page.setCookie(...cookies);
    console.log(`[COOKIES] Cookies loaded for ${account.email}`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log(`[COOKIES] No cookie file found for ${account.email}`);
    } else {
      console.error(
        `[COOKIES] Failed to load cookies for ${account.email}:`,
        error.message
      );
    }
    return false;
  }
}

async function validateCookies(page, account = null, state = null, options = {}) {
  try {
    console.log("[COOKIES] Validating session via /users/posts/list ...");
    await page.goto(POSTS_LIST_URL, {
      waitUntil: "networkidle2",
      timeout: 90000
    });

    const valid = isPostsListUrl(page.url());
    if (valid && account) {
      await assertAccountNotBanned(page, account, state, options);
    }
    console.log(valid ? "[COOKIES] Cookies valid" : "[COOKIES] Cookies expired");
    return valid;
  } catch (error) {
    if (String(error?.type || "").toLowerCase() === "banned") {
      throw error;
    }
    console.warn(`[COOKIES] Session validation failed: ${error.message}`);
    return false;
  }
}

async function runAccount(account) {
  const { launchBrowser } = require("./accountEngine");
  const { browser, page } = await launchBrowser(account);

  try {
    console.log("Testing Proxy + UserAgent for:", account.email);

    await page.goto("https://api.ipify.org?format=json", {
      waitUntil: "networkidle2"
    });
    const ip = await page.evaluate(() => document.body.innerText);
    console.log("Proxy IP Used:", ip);

    const ua = await page.evaluate(() => navigator.userAgent);
    console.log("User Agent Used:", ua);

    console.log("Test completed");
  } catch (err) {
    console.error("Worker error:", err.message);
  } finally {
    await browser.close();
  }
}

async function testProxyNavigation(account) {
  const { launchBrowser } = require("./accountEngine");
  const { browser, page } = await launchBrowser(account);

  try {
    await page.goto("https://api.ipify.org?format=json", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    const proxyIpRaw = await page.evaluate(() => document.body.innerText);

    await page.goto("https://megapersonals.eu/", {
      waitUntil: "networkidle2",
      timeout: 90000
    });

    const pageTitle = await page.title();
    const finalUrl = page.url();

    if (finalUrl.includes("megapersonals.eu")) {
      console.log("redirected succesfully tO (mega)");
    }

    return {
      success: true,
      proxyIp: proxyIpRaw,
      pageTitle,
      finalUrl
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  } finally {
    await browser.close();
  }
}

async function clickFirstByText(page, matcher) {
  return page.evaluate((needle) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const candidates = Array.from(
      document.querySelectorAll(
        "a, button, input[type='button'], input[type='submit'], [role='button']"
      )
    );

    const target = candidates.find((node) => {
      const text = normalize(node.textContent || node.value || "");
      if (!text) return false;
      if (Array.isArray(needle)) {
        return needle.some((part) => text.includes(String(part || "").toLowerCase()));
      }
      return text.includes(String(needle || "").toLowerCase());
    });

    if (!target) return false;
    target.click();
    return true;
  }, matcher);
}

async function handleGateAndTerms(page) {
  const gateHandled = await page
    .evaluate(async () => {
      const visible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const gate = document.querySelector("#ageCheckPopupDiv");
      if (!visible(gate)) return false;

      const termsContainer = document.querySelector(
        "#ageCheckPopupInner .terms-container, .terms-container"
      );
      if (termsContainer) {
        let guard = 0;
        while (
          termsContainer.scrollTop + termsContainer.clientHeight <
            termsContainer.scrollHeight - 4 &&
          guard < 50
        ) {
          termsContainer.scrollTop += 300;
          await new Promise((resolve) => setTimeout(resolve, 120));
          guard += 1;
        }
      }

      const agreeCheckbox = document.querySelector("#checkbox-agree");
      if (agreeCheckbox && !agreeCheckbox.checked) {
        agreeCheckbox.click();
      }

      const agreeButton = document.querySelector("#ageagree");
      if (agreeButton) {
        agreeButton.click();
        return true;
      }

      return false;
    })
    .catch(() => false);

  if (gateHandled) {
    await page
      .waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 45000
      })
      .catch(() => null);
    console.log("[LOGIN] Passed gate");
  }

  const termsAccepted = await page
    .evaluate(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const candidates = Array.from(
        document.querySelectorAll("button, input[type='button'], input[type='submit']")
      );
      const checkboxCandidates = Array.from(
        document.querySelectorAll("input[type='checkbox']")
      );

      const agreeButton = candidates.find((node) => {
        const text = normalize(node.textContent || node.value || "");
        return text === "i agree" || text === "agree";
      });

      if (!agreeButton) return false;

      checkboxCandidates.forEach((node) => {
        if (!node.checked) {
          node.click();
        }
      });

      agreeButton.click();
      return true;
    })
    .catch(() => false);

  if (termsAccepted) {
    await page
      .waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 45000
      })
      .catch(() => null);
    console.log("[LOGIN] Terms accepted");
  }
}

async function navigateToLoginPage(page) {
  if (isLoginUrl(page.url())) {
    return true;
  }

  const clickedPostNow = await clickFirstByText(page, ["post now", "post ad"]);
  if (clickedPostNow) {
    await page
      .waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 45000
      })
      .catch(() => null);
  }

  if (!isLoginUrl(page.url())) {
    await page.goto(LOGIN_URL, {
      waitUntil: "networkidle2",
      timeout: 90000
    });
  }

  if (isLoginUrl(page.url())) {
    console.log("[LOGIN] Reached login page");
    return true;
  }

  return false;
}

async function detectBadCaptcha(page) {
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes("bad_captcha") || currentUrl.includes("the%20captcha")) {
    return true;
  }

  return page
    .evaluate(() => {
      const text = String(document.body?.innerText || "").toLowerCase();
      return (
        text.includes("bad captcha") ||
        text.includes("wrong captcha") ||
        text.includes("invalid captcha")
      );
    })
    .catch(() => false);
}

function isInvalidCredentialsUrl(url) {
  const value = String(url || "").trim();
  if (!value) return false;

  const lowered = value.toLowerCase();
  if (!lowered.includes("/users/auth/login")) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return String(parsed.searchParams.get("error") || "").toLowerCase() === "t";
  } catch {
    return /[?&]error=t(?:&|$)/i.test(lowered);
  }
}

async function clickLoginSubmitFallback(page) {
  return page
    .evaluate(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const isVisible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const hasSubmitIntent = (value) =>
        /(submit|sign[\s-]?in|log[\s-]?in|proceed|continue)/i.test(
          String(value || "")
        );

      const candidates = Array.from(
        document.querySelectorAll(
          "button, input[type='submit'], input[type='button'], [role='button']"
        )
      ).filter((node) => isVisible(node));

      if (candidates.length === 0) {
        return { clicked: false, reason: "no_visible_candidates" };
      }

      const passwordInput = document.querySelector("input[type='password']");
      const loginForm = passwordInput?.closest("form") || null;

      let bestNode = null;
      let bestScore = -Infinity;
      let bestLabel = "";

      for (const node of candidates) {
        const type = normalize(node.getAttribute("type"));
        const id = normalize(node.id);
        const name = normalize(node.getAttribute("name"));
        const classes = normalize(node.className);
        const text = normalize(node.textContent || node.value || "");
        const aria = normalize(node.getAttribute("aria-label"));
        const inLoginForm = Boolean(loginForm && loginForm.contains(node));

        if (
          text.includes("start here") ||
          text.includes("forgot") ||
          text.includes("refresh") ||
          id.includes("refresh") ||
          classes.includes("refresh") ||
          classes.includes("captcha-refresh") ||
          aria.includes("refresh")
        ) {
          continue;
        }

        let score = 0;
        if (type === "submit") score += 12;
        if (hasSubmitIntent(text)) score += 10;
        if (hasSubmitIntent(id) || hasSubmitIntent(name) || hasSubmitIntent(classes)) {
          score += 8;
        }
        if (inLoginForm) score += 6;
        if (node.tagName === "BUTTON") score += 2;

        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
          bestLabel = text || id || name || node.tagName.toLowerCase();
        }
      }

      if (!bestNode || bestScore < 6) {
        if (loginForm && passwordInput) {
          try {
            loginForm.requestSubmit();
            return { clicked: true, reason: "login_form_request_submit" };
          } catch {
            loginForm.submit();
            return { clicked: true, reason: "login_form_submit" };
          }
        }
        return { clicked: false, reason: "no_submit_candidate_match" };
      }

      bestNode.click();
      return {
        clicked: true,
        reason: `clicked_candidate(score=${bestScore},label=${bestLabel.slice(0, 80)})`
      };
    })
    .catch((error) => ({
      clicked: false,
      reason: `evaluate_error:${error.message}`
    }));
}

async function submitLoginAttempt(page, account) {
  const { element: emailInput } = await findFirstElement(page, LOGIN_SELECTORS.email, {
    timeout: 20000
  });
  const { element: passwordInput } = await findFirstElement(
    page,
    LOGIN_SELECTORS.password,
    {
      timeout: 20000
    }
  );

  if (!emailInput || !passwordInput) {
    throw new Error("Login form fields not found.");
  }

  await emailInput.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await emailInput.type(account.email, { delay: 50 });

  await passwordInput.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await passwordInput.type(account.password, { delay: 50 });
  console.log("[LOGIN] Credentials filled");

  const { element: captchaElement } = await findFirstElement(
    page,
    LOGIN_SELECTORS.captchaImage,
    { timeout: 8000 }
  );
  if (captchaElement) {
    const solvedCaptcha = await solveCaptchaFromPage(page, captchaElement);
    if (!solvedCaptcha) {
      throw new Error("Captcha solver returned an empty solution.");
    }

    const { element: captchaInput } = await findFirstElement(
      page,
      LOGIN_SELECTORS.captchaInput,
      { timeout: 10000 }
    );
    if (!captchaInput) {
      throw new Error("Captcha input field was not found.");
    }

    await captchaInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await captchaInput.type(solvedCaptcha, { delay: 35 });
    console.log(`[LOGIN] Captcha solved: ${solvedCaptcha}`);
  }

  const { element: submitButton } = await findFirstElement(
    page,
    LOGIN_SELECTORS.submit,
    {
      timeout: 10000
    }
  );

  let submitAction = "selector_click";
  if (submitButton) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(
        () => null
      ),
      page.evaluate((button) => button.click(), submitButton)
    ]);
  } else {
    console.warn(
      "[LOGIN] Submit button not found via primary selectors. Trying fallback submit strategy."
    );

    const fallbackResult = await clickLoginSubmitFallback(page);
    if (fallbackResult?.clicked) {
      submitAction = `fallback:${fallbackResult.reason || "clicked"}`;
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(
        () => null
      );
    } else {
      // Final fallback: many login forms submit on Enter from password/captcha field.
      submitAction = `enter_key:${fallbackResult?.reason || "no_reason"}`;
      const focusResult = await page
        .evaluate(() => {
          const fields = [
            document.querySelector("#captcha_code"),
            document.querySelector("input[name='captcha']"),
            document.querySelector("#password"),
            document.querySelector("input[name='password']"),
            document.querySelector("input[type='password']")
          ].filter(Boolean);

          if (fields.length === 0) return false;
          fields[0].focus();
          return true;
        })
        .catch(() => false);

      if (!focusResult) {
        throw new Error(
          `Login submit button not found and fallback failed (${fallbackResult?.reason || "unknown"})`
        );
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(
          () => null
        ),
        page.keyboard.press("Enter")
      ]);
    }
  }

  const redirectUrl = page.url();
  console.log(`[LOGIN] Submitted (${submitAction}), redirected to: ${redirectUrl}`);

  return {
    redirectUrl,
    badCaptcha: await detectBadCaptcha(page)
  };
}

async function performFullLogin(page, account, verificationOptions = {}) {
  try {
    console.log(`[LOGIN] Performing full login for ${account.email}`);

    await page.goto(ROOT_URL, {
      waitUntil: "networkidle2",
      timeout: 90000
    });

    await handleGateAndTerms(page);

    const reachedLogin = await navigateToLoginPage(page);
    if (!reachedLogin) {
      console.error(`[LOGIN] Could not reach login page for ${account.email}`);
      return false;
    }

    const maxCaptchaRetries = 3;
    for (let attempt = 1; attempt <= maxCaptchaRetries; attempt += 1) {
      const attemptResult = await submitLoginAttempt(page, account);
      const currentUrl = attemptResult.redirectUrl;

      if (isInvalidCredentialsUrl(currentUrl)) {
        const reason = "Acc Pass Wrong";
        console.error(`[LOGIN] ${reason} for ${account.email}`);
        throw createWorkerError(
          "credentials_invalid",
          `${reason} for ${account.email}`
        );
      }

      if (isPostsListUrl(currentUrl)) {
        console.log("[LOGIN] Login successful, no verification needed");
        return true;
      }

      if (isTwoFactorUrl(currentUrl)) {
        console.log("[LOGIN] Verification required");
        const verificationResult = await handleDeviceVerification(
          page,
          account,
          verificationOptions
        );
        if (verificationResult === "AWAITING_USER_CODE") {
          return "awaiting_verification";
        }
        return Boolean(verificationResult);
      }

      if (isLoginUrl(currentUrl) && attemptResult.badCaptcha) {
        if (attempt < maxCaptchaRetries) {
          console.warn(
            `[LOGIN] Wrong captcha for ${account.email} (attempt ${attempt}/${maxCaptchaRetries}), retrying`
          );
          await page.goto(LOGIN_URL, {
            waitUntil: "networkidle2",
            timeout: 90000
          });
          continue;
        }

        console.error(`[LOGIN] Captcha failed after ${maxCaptchaRetries} attempts`);
        return false;
      }

      if (isLoginUrl(currentUrl) && attempt < maxCaptchaRetries) {
        console.warn(
          `[LOGIN] Login still on login page (attempt ${attempt}/${maxCaptchaRetries}), retrying`
        );
        await page.goto(LOGIN_URL, {
          waitUntil: "networkidle2",
          timeout: 90000
        });
        continue;
      }

      console.error(`[LOGIN] Unexpected redirect for ${account.email}: ${currentUrl}`);
      return false;
    }

    return false;
  } catch (error) {
    console.error(`[LOGIN] Failed for ${account.email}:`, error.message);
    if (error?.stack) {
      console.error(`[LOGIN] Stack for ${account.email}:\n${error.stack}`);
    }
    try {
      const canScreenshot =
        page &&
        (typeof page.isClosed !== "function" || !page.isClosed());

      if (canScreenshot) {
        await page.screenshot({
          path: `login-error-${account.email}-${Date.now()}.png`
        });
      }
    } catch (screenshotError) {
      console.error(
        `[LOGIN] Failed to save login error screenshot for ${account.email}:`,
        screenshotError.message
      );
    }
    if (error?.type === "credentials_invalid") {
      throw error;
    }
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithStop(state, waitMs) {
  let remainingMs = Math.max(0, Math.floor(waitMs || 0));

  while (remainingMs > 0 && !state.stopped && !state.forceCycle) {
    const step = Math.min(remainingMs, 5000);
    await sleep(step);
    remainingMs -= step;
  }

  return {
    completed: remainingMs <= 0,
    interruptedByStop: Boolean(state.stopped),
    interruptedByWatchdog: Boolean(state.forceCycle)
  };
}

function formatDuration(waitMs) {
  const totalSeconds = Math.max(0, Math.ceil(waitMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0 && seconds > 0) {
    return `${minutes} minute(s) ${seconds} second(s)`;
  }

  if (minutes > 0) {
    return `${minutes} minute(s)`;
  }

  return `${seconds} second(s)`;
}

function formatDurationHms(waitMs) {
  const totalSeconds = Math.max(0, Math.ceil(Number(waitMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0")
  ].join(":");
}

function formatDurationCompact(waitMs) {
  const totalSeconds = Math.max(0, Math.ceil(Number(waitMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function toShortReason(message, fallback = "unknown") {
  const raw = String(message || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) {
    return fallback;
  }

  const compact = raw
    .replace(/^login failed for /i, "")
    .replace(/^session validation failed for /i, "")
    .replace(/^verification code timeout for /i, "")
    .replace(/^browser launch failed:\s*/i, "")
    .trim();

  if (!compact) {
    return fallback;
  }

  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

async function logNextBumpSchedule(account, delayMs, options = {}) {
  const safeDelayMs = Math.max(0, Math.floor(Number(delayMs || 0)));
  const nowMs = Number(options?.nowMs) || Date.now();
  const providedLastRunAt = options?.lastRunAt ? new Date(options.lastRunAt) : null;
  const lastRunAt = providedLastRunAt && !Number.isNaN(providedLastRunAt.valueOf())
    ? providedLastRunAt
    : new Date(nowMs);
  const nextBumpAt = new Date(nowMs + safeDelayMs);
  const totalSeconds = Math.max(1, Math.ceil(safeDelayMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const message = `Next bump scheduled: ${account.email}. Next in ${minutes} minute(s) ${seconds} second(s).`;

  try {
    await Account.findByIdAndUpdate(account._id, {
      nextBumpAt,
      lastBumpAt: lastRunAt,
      nextBumpDelayMs: safeDelayMs
    }).catch(() => null);

    account.nextBumpAt = nextBumpAt;
    account.lastBumpAt = lastRunAt;
    account.nextBumpDelayMs = safeDelayMs;

    await logActivity({
      level: "info",
      message,
      email: account.email,
      accountId: account._id,
      metadata: {
        nextBumpAt,
        lastRunAt,
        delayMs: safeDelayMs,
        intervalMs: safeDelayMs
      }
    }).catch(() => null);

    emitAccountUpdate(
      account,
      {
        nextBumpAt: nextBumpAt.toISOString(),
        lastBumpAt: lastRunAt.toISOString(),
        nextBumpDelayMs: safeDelayMs
      },
      {
        nextRun: {
          nextRunAt: nextBumpAt.toISOString(),
          lastRunAt: lastRunAt.toISOString(),
          intervalMs: safeDelayMs
        }
      }
    );

    return {
      nextBumpAt,
      lastRunAt,
      delayMs: safeDelayMs,
      message
    };
  } catch (error) {
    console.error(
      `[LOG] Failed to record next bump schedule for ${account.email}:`,
      error.message
    );

    return {
      nextBumpAt,
      lastRunAt,
      delayMs: safeDelayMs,
      message
    };
  }
}

function calculateRegularDelayMs(baseInterval, randomMin, randomMax) {
  const randomOffsetMinutes =
    randomMin + Math.random() * Math.max(0, randomMax - randomMin);
  const configuredDelayMs = (baseInterval + randomOffsetMinutes) * 60 * 1000;
  // Never schedule below the platform-safe minimum publish interval.
  return Math.max(configuredDelayMs, MIN_PUBLISH_INTERVAL_MS, 1000);
}

function parseCountdownTimer(text) {
  const match = String(text || "").match(/\[in (\d{2}):(\d{2}):(\d{2})\]/i);
  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return 0;
  }

  return Math.max(0, (hours * 3600 + minutes * 60 + seconds) * 1000);
}

async function detectCooldownPopup(page) {
  await sleep(2000);

  const probe = await page.evaluate(() => {
    const marker = "you may only publish once every";
    const normalizeText = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const bodyText = normalizeText(document.body?.innerText || "");
    const lowerBodyText = bodyText.toLowerCase();

    if (!lowerBodyText.includes(marker)) {
      return {
        hasCooldown: false,
        sourceText: "",
        clickedOk: false
      };
    }

    const dialogSelectors = [
      "[role='dialog']",
      ".modal",
      ".modal-content",
      ".modal-body",
      ".popup",
      ".swal2-popup"
    ];

    let sourceText = bodyText;
    for (const selector of dialogSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const nodeText = normalizeText(node.innerText || node.textContent);
        if (nodeText.toLowerCase().includes(marker)) {
          sourceText = nodeText;
          break;
        }
      }
      if (sourceText.toLowerCase().includes(marker)) {
        break;
      }
    }

    const buttons = Array.from(document.querySelectorAll("button[type='button'], button, [role='button']"));
    const okButton = buttons.find((node) => {
      const text = normalizeText(node.textContent || "").toLowerCase();
      return text === "ok";
    });

    if (okButton) {
      okButton.click();
    }

    return {
      hasCooldown: true,
      sourceText,
      clickedOk: Boolean(okButton)
    };
  });

  if (!probe?.hasCooldown) {
    return {
      hasCooldown: false,
      waitTime: 0,
      waitTimeMs: 0,
      sourceText: "",
      clickedOk: false
    };
  }

  const waitTimeMs = parseCountdownTimer(probe.sourceText);

  return {
    hasCooldown: true,
    waitTime: waitTimeMs,
    waitTimeMs,
    sourceText: probe.sourceText,
    clickedOk: Boolean(probe.clickedOk)
  };
}

function parseCooldownTime(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  const countdownMs = parseCountdownTimer(normalized);
  if (countdownMs > 0) {
    return countdownMs;
  }

  const minuteMatch = normalized.match(/(\d+)\s*(?:minutes?|mins?|min|m)\b/i);
  const secondMatch = normalized.match(/(\d+)\s*(?:seconds?|secs?|sec|s)\b/i);
  const mmssMatch = normalized.match(/(\d{1,2})\s*:\s*(\d{1,2})/);

  let minutes = minuteMatch ? Number(minuteMatch[1]) : null;
  let seconds = secondMatch ? Number(secondMatch[1]) : null;

  if (
    (minutes === null || Number.isNaN(minutes)) &&
    (seconds === null || Number.isNaN(seconds)) &&
    mmssMatch
  ) {
    minutes = Number(mmssMatch[1]);
    seconds = Number(mmssMatch[2]);
  }

  if (
    (minutes === null || Number.isNaN(minutes)) &&
    (seconds === null || Number.isNaN(seconds))
  ) {
    return null;
  }

  const safeMinutes =
    minutes === null || Number.isNaN(minutes) ? 0 : Math.max(0, minutes);
  const safeSeconds =
    seconds === null || Number.isNaN(seconds) ? 0 : Math.max(0, seconds);
  const totalMs = (safeMinutes * 60 + safeSeconds) * 1000;

  return totalMs > 0 ? totalMs : null;
}

async function detectBumpCooldown(page) {
  const probe = await page.evaluate(() => {
    const cooldownHintRegex =
      /wait|cooldown|try\s+again|too\s+soon|minutes?|mins?|seconds?|secs?/i;

    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const normalizeText = (text) =>
      String(text || "")
        .replace(/\s+/g, " ")
        .trim();

    const candidates = [];
    const pushCandidate = (text) => {
      const normalized = normalizeText(text);
      if (!normalized) return;
      if (normalized.length > 500) return;
      if (!cooldownHintRegex.test(normalized)) return;
      candidates.push(normalized);
    };

    const buttonSelectors = [
      "#managePublishAd",
      "[id='managePublishAd']",
      "button[id*='managePublishAd']",
      "a[id*='managePublishAd']"
    ];
    const allButtons = [];
    buttonSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        allButtons.push(node);
      });
    });
    const uniqueButtons = Array.from(new Set(allButtons));
    const visibleButtons = uniqueButtons.filter((node) => visible(node));
    const button = visibleButtons[0] || null;

    const buttonDisabled = Boolean(
      button &&
        (button.disabled ||
          button.matches(":disabled") ||
          button.hasAttribute("disabled") ||
          button.getAttribute("aria-disabled") === "true" ||
          button.classList.contains("disabled"))
    );

    if (button) {
      pushCandidate(button.innerText || button.textContent);
    }

    const candidateSelectors = [
      ".modal",
      ".modal-body",
      ".modal-content",
      ".popup",
      ".swal2-popup",
      ".alert",
      ".toast",
      ".notification",
      ".error",
      "[role='dialog']",
      "[class*='cooldown']",
      "[class*='wait']"
    ];

    candidateSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!visible(node)) return;
        pushCandidate(node.innerText || node.textContent);
      });
    });

    const bodyLines = String(document.body?.innerText || "")
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .filter((line) => /\d/.test(line) && cooldownHintRegex.test(line))
      .slice(0, 40);

    bodyLines.forEach((line) => pushCandidate(line));

    const noButtonHintLines = String(document.body?.innerText || "")
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .filter((line) =>
        /(no\s+(?:posts?|ads?|listings?)|nothing\s+to\s+bump|expired|deleted|removed|draft)/i.test(
          line
        )
      )
      .slice(0, 3);

    return {
      buttonFound: uniqueButtons.length > 0,
      buttonVisible: Boolean(button),
      buttonDisabled,
      candidates: Array.from(new Set(candidates)).slice(0, 40),
      noButtonHint: noButtonHintLines[0] || ""
    };
  });

  let parsedWaitMs = null;
  let sourceText = "";

  for (const text of probe.candidates) {
    const parsed = parseCooldownTime(text);
    if (parsed) {
      parsedWaitMs = parsed;
      sourceText = text;
      break;
    }
  }

  const hasCooldown = Boolean(probe.buttonDisabled || parsedWaitMs);

  return {
    hasCooldown,
    waitTimeMs: parsedWaitMs,
    sourceText:
      sourceText ||
      (probe.buttonDisabled ? "Bump button is disabled (cooldown assumed)." : ""),
    buttonVisible: probe.buttonVisible,
    buttonDisabled: probe.buttonDisabled,
    buttonFound: probe.buttonFound,
    noButtonHint: probe.noButtonHint
  };
}

async function returnToPostsList(page) {
  if (page.url().includes("/success_publish/")) {
    console.log("[BUMP] Redirected to success page.");
    const clickedMyPosts = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("a, button"));
      const target = candidates.find((node) => {
        const text = String(node.textContent || "")
          .trim()
          .toLowerCase();
        const href = String(node.getAttribute?.("href") || "")
          .trim()
          .toLowerCase();
        return (
          text.includes("my posts") ||
          href.includes("/users/posts/list") ||
          href.includes("/users/posts")
        );
      });

      if (!target) return false;
      target.click();
      return true;
    });

    if (clickedMyPosts) {
      console.log("[BUMP] Clicking My Posts link...");
      await page
        .waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 45000
        })
        .catch(() => null);
    }
  }

  if (!page.url().includes("/users/posts/list")) {
    await page.goto(POSTS_LIST_URL, {
      waitUntil: "networkidle2",
      timeout: 90000
    });
  }
}

async function startBumpLoop(page, account, state = { stopped: false }, options = {}) {
  const ip = options?.ip || "";
  const proxyLabel = resolveProxyLabel(account, ip);
  let currentBumpConfig = normalizeBumpConfig(account);
  let loopExitReason = "completed";
  let bumpCount = Number(account.totalBumpsToday || 0);
  const selfTest = getSelfTestConfig(account);
  let selfTestCycleCount = 0;
  let selfTestPatternIndex = 0;

  const refreshBumpConfig = async () => {
    const latest = await Account.findById(account._id)
      .select(
        "baseInterval randomMin randomMax maxDailyRuntime maxDailyBumps runtimeWindow timezone"
      )
      .lean()
      .catch(() => null);

    if (latest) {
      account.baseInterval = latest.baseInterval;
      account.randomMin = latest.randomMin;
      account.randomMax = latest.randomMax;
      account.maxDailyRuntime = latest.maxDailyRuntime;
      account.maxDailyBumps = latest.maxDailyBumps;
      account.runtimeWindow = latest.runtimeWindow;
      account.timezone = latest.timezone;
    }

    currentBumpConfig = normalizeBumpConfig(account);
    return currentBumpConfig;
  };

  const WATCHDOG_INTERVAL_MS = 15 * 1000;
  const WATCHDOG_OVERDUE_MS = 30 * 1000;
  const WATCHDOG_ACTIVE_STATUSES = new Set([
    "active",
    "bumping",
    "waiting_cooldown"
  ]);

  const clearScheduledNextBump = () => {
    state.nextBumpAtMs = null;
  };

  const setScheduledNextBump = (value) => {
    const ts = new Date(value).getTime();
    state.nextBumpAtMs = Number.isFinite(ts) ? ts : null;
  };

  const stopBumpWatchdog = () => {
    if (state.bumpWatchdogTimer) {
      clearInterval(state.bumpWatchdogTimer);
      state.bumpWatchdogTimer = null;
    }
  };

  const startBumpWatchdog = () => {
    stopBumpWatchdog();
    state.bumpWatchdogTimer = setInterval(() => {
      if (state.stopped) return;

      const nextBumpAtMs = Number(state.nextBumpAtMs || 0);
      if (!Number.isFinite(nextBumpAtMs) || nextBumpAtMs <= 0) return;

      const status = String(state.currentStatus || "").trim().toLowerCase();
      if (!WATCHDOG_ACTIVE_STATUSES.has(status)) return;

      if (Date.now() > nextBumpAtMs + WATCHDOG_OVERDUE_MS) {
        if (!state.forceCycle) {
          state.forceCycle = true;
          console.warn("[BUMP] Watchdog fired: next bump overdue, restarting cycle");
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  };

  const setBumpingStatus = async () => {
    await updateStatus(account._id, "bumping", {
      ip,
      email: account.email
    }).catch(() => null);
    state.currentStatus = "bumping";
    setWorkerStep(state, "bumping", page);
    await Account.findByIdAndUpdate(account._id, {
      status: "bumping",
      waitingUntil: null
    }).catch(() => null);
  };

  const scheduleNextBump = async (delayMs, options = {}) => {
    const safeDelayMs = Math.max(1000, Math.floor(Number(delayMs || 0)));
    const providedLastRunAt = options?.lastRunAt ? new Date(options.lastRunAt) : null;
    const accountLastBumpAt = account?.lastBumpAt ? new Date(account.lastBumpAt) : null;
    const fallbackLastRunAt = new Date();
    const lastRunAt =
      providedLastRunAt && !Number.isNaN(providedLastRunAt.valueOf())
        ? providedLastRunAt
        : accountLastBumpAt && !Number.isNaN(accountLastBumpAt.valueOf())
          ? accountLastBumpAt
          : fallbackLastRunAt;

    const schedule = await logNextBumpSchedule(account, safeDelayMs, {
      lastRunAt
    });

    const nextBumpAt =
      schedule?.nextBumpAt && !Number.isNaN(new Date(schedule.nextBumpAt).valueOf())
        ? new Date(schedule.nextBumpAt)
        : new Date(Date.now() + safeDelayMs);

    setScheduledNextBump(nextBumpAt);

    const totalSeconds = Math.max(1, Math.ceil(safeDelayMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    console.log(
      `[BUMP] Scheduling next bump at ${nextBumpAt.toISOString()} (in ${minutes}m ${seconds}s)`
    );

    return {
      delayMs: safeDelayMs,
      nextBumpAt,
      lastRunAt
    };
  };

  const waitForScheduledDelay = async (delayMs) => {
    state.forceCycle = false;
    const waitResult = await waitWithStop(state, delayMs);
    if (waitResult?.interruptedByWatchdog && !state.stopped) {
      state.forceCycle = false;
      return false;
    }
    return !state.stopped;
  };

  const getConfiguredDelayMs = () => {
    const { baseInterval, randomMin, randomMax } = currentBumpConfig;
    return calculateRegularDelayMs(baseInterval, randomMin, randomMax);
  };

  const handleCooldownWait = async (cooldownInfo, stageLabel) => {
    const { baseInterval, randomMin, randomMax } = currentBumpConfig;
    const fallbackDelayMs = calculateRegularDelayMs(
      baseInterval,
      randomMin,
      randomMax
    );
    const parsedCooldownMs = Number(
      cooldownInfo?.waitTimeMs ?? cooldownInfo?.waitTime
    );
    const hasParsedCooldown =
      Number.isFinite(parsedCooldownMs) && parsedCooldownMs > 0;

    let effectiveWaitMs = fallbackDelayMs;

    if (hasParsedCooldown) {
      if (parsedCooldownMs > COOLDOWN_MAX_WAIT_MS) {
        console.warn(
          `[BUMP] Cooldown ${formatDuration(
            parsedCooldownMs
          )} exceeds 60 minutes (${stageLabel}). Using scheduled delay ${formatDuration(
            fallbackDelayMs
          )}.`
        );
      } else {
        const parsedWithBufferMs = parsedCooldownMs + COOLDOWN_BUFFER_MS;
        effectiveWaitMs = Math.max(
          parsedWithBufferMs,
          fallbackDelayMs,
          MIN_PUBLISH_INTERVAL_MS
        );
      }
    } else {
      console.warn(
        `[BUMP] Cooldown detected (${stageLabel}) but time could not be parsed. Using scheduled delay ${formatDuration(
          fallbackDelayMs
        )}.`
      );
      effectiveWaitMs = Math.max(fallbackDelayMs, MIN_PUBLISH_INTERVAL_MS);
    }

    const cooldownMinutes = Math.max(
      1,
      Math.ceil(effectiveWaitMs / 60000)
    );
    const waitingUntil = new Date(Date.now() + effectiveWaitMs);

    await updateStatus(account._id, "waiting_cooldown", {
      ip,
      email: account.email
    }).catch(() => null);
    state.currentStatus = "waiting_cooldown";
    setWorkerStep(state, "waiting_cooldown", page);
    await Account.findByIdAndUpdate(account._id, {
      status: "waiting_cooldown",
      lastCooldownDetected: new Date(),
      cooldownMinutes,
      waitingUntil
    }).catch(() => null);

    console.log(`[BUMP] Cooldown detected: waiting ${effectiveWaitMs} ms`);
    console.log(
      `[BUMP] Cooldown schedule policy (${stageLabel}): parsed=${hasParsedCooldown ? formatDuration(parsedCooldownMs) : "n/a"}, configured=${formatDuration(
        fallbackDelayMs
      )}, minimum=${formatDuration(MIN_PUBLISH_INTERVAL_MS)}, effective=${formatDuration(
        effectiveWaitMs
      )}`
    );
    if (cooldownInfo?.sourceText) {
      console.log(`[BUMP] Cooldown source: ${cooldownInfo.sourceText}`);
    }

    const schedule = await scheduleNextBump(effectiveWaitMs, {
      lastRunAt: account.lastBumpAt || new Date()
    });
    await logActivity({
      level: "warning",
      message: `\u23F3 ${account.email}\nCooldown detected\nNext in ${formatDurationCompact(
        effectiveWaitMs
      )}\nProxy: ${proxyLabel}`,
      ip,
      email: account.email,
      accountId: account._id,
      metadata: {
        stage: stageLabel,
        parsedCooldownMs: hasParsedCooldown ? parsedCooldownMs : null,
        effectiveWaitMs,
        nextBumpAt: schedule?.nextBumpAt || null,
        proxy: proxyLabel
      }
    }).catch(() => null);
    await waitForScheduledDelay(effectiveWaitMs + 2000);
    if (state.stopped) {
      return;
    }

    await setBumpingStatus();
    console.log("[BUMP] Cooldown expired, retrying bump...");
  };

  await refreshBumpConfig();
  startBumpWatchdog();
  await setBumpingStatus();
  if (selfTest.enabled) {
    console.log(
      `[BUMP][SELF-TEST] Enabled for ${account.email}. pattern=${selfTest.pattern.join(
        ","
      )} successDelayMs=${selfTest.successDelayMs} cooldownDelayMs=${
        selfTest.cooldownDelayMs
      } errorRetryDelayMs=${selfTest.errorRetryDelayMs} maxCycles=${selfTest.maxCycles || "infinite"}`
    );
  }

  try {
    while (!state.stopped) {
      await refreshBumpConfig();
      clearScheduledNextBump();
      setWorkerStep(state, "bump_cycle", page);
      console.log(`[BUMP] Bump cycle begin for ${account.email}`);

      if (selfTest.enabled) {
        if (selfTest.maxCycles > 0 && selfTestCycleCount >= selfTest.maxCycles) {
          console.log(
            `[BUMP][SELF-TEST] Reached configured cycle limit (${selfTest.maxCycles}).`
          );
          break;
        }

        const outcome =
          selfTest.pattern[selfTestPatternIndex % selfTest.pattern.length] || "success";
        selfTestPatternIndex += 1;
        selfTestCycleCount += 1;
        setWorkerStep(state, `self_test_${outcome}`, page);
        console.log(
          `[BUMP][SELF-TEST] Cycle ${selfTestCycleCount}${
            selfTest.maxCycles > 0 ? `/${selfTest.maxCycles}` : ""
          } outcome=${outcome}`
        );

        if (outcome === "cooldown") {
          const effectiveWaitMs = selfTest.cooldownDelayMs;
          const waitingUntil = new Date(Date.now() + effectiveWaitMs);
          await updateStatus(account._id, "waiting_cooldown", {
            ip,
            email: account.email
          }).catch(() => null);
          state.currentStatus = "waiting_cooldown";
          setWorkerStep(state, "waiting_cooldown", page);
          await Account.findByIdAndUpdate(account._id, {
            status: "waiting_cooldown",
            lastCooldownDetected: new Date(),
            cooldownMinutes: Math.max(1, Math.ceil(effectiveWaitMs / 60000)),
            waitingUntil
          }).catch(() => null);

          console.log(`[BUMP] Cooldown detected: waiting ${effectiveWaitMs} ms`);
          const schedule = await scheduleNextBump(effectiveWaitMs, {
            lastRunAt: account.lastBumpAt || new Date()
          });
          await logActivity({
            level: "warning",
            message: `\u23F3 ${account.email}\nCooldown detected\nNext in ${formatDurationCompact(
              effectiveWaitMs
            )}\nProxy: ${proxyLabel}`,
            ip,
            email: account.email,
            accountId: account._id,
            metadata: {
              stage: "self_test",
              effectiveWaitMs,
              nextBumpAt: schedule?.nextBumpAt || null,
              proxy: proxyLabel
            }
          }).catch(() => null);
          const keepRunning = await waitForScheduledDelay(effectiveWaitMs + 2000);
          if (!keepRunning || state.stopped) break;
          await setBumpingStatus();
          continue;
        }

        if (outcome === "error") {
          const retryDelayMs = selfTest.errorRetryDelayMs;
          console.error(
            `[BUMP][SELF-TEST] Simulated bump error. Retrying in ${retryDelayMs} ms`
          );
          await scheduleNextBump(retryDelayMs, {
            lastRunAt: account.lastBumpAt || new Date()
          });
          const keepRunning = await waitForScheduledDelay(retryDelayMs);
          if (!keepRunning || state.stopped) break;
          continue;
        }

        const bumpedAt = new Date();
        bumpCount += 1;
        account.lastBumpAt = bumpedAt;
        await Account.findByIdAndUpdate(account._id, {
          status: "bumping",
          lastBumpAt: bumpedAt,
          totalBumpsToday: bumpCount,
          waitingUntil: null,
          cooldownMinutes: null
        }).catch(() => null);

        console.log("[BUMP] Bump success");
        const delayMs = selfTest.successDelayMs;
        await scheduleNextBump(delayMs, { lastRunAt: bumpedAt });
        await logActivity({
          level: "success",
          message: `\uD83D\uDFE2 ${account.email}\nBump successful\nNext in ${formatDurationCompact(
            delayMs
          )}\nProxy: ${proxyLabel}`,
          ip,
          email: account.email,
          accountId: account._id,
          metadata: {
            proxy: proxyLabel,
            bumpedAt,
            nextDelayMs: delayMs
          }
        }).catch(() => null);
        const keepRunning = await waitForScheduledDelay(delayMs);
        if (!keepRunning || state.stopped) break;
        continue;
      }

      if (!isWithinRuntimeWindow(account.runtimeWindow, account.timezone)) {
        console.log(`[BUMP] ${account.email} is outside runtime window; stopping.`);
        loopExitReason = "runtime_window_closed";
        break;
      }

      try {
        if (!isPostsListUrl(page.url())) {
          await page.goto(POSTS_LIST_URL, {
            waitUntil: "networkidle2",
            timeout: 90000
          });
        }
        console.log("[BUMP] On posts list page");
        await assertAccountNotBanned(page, account, state, { ip });

        await sleep(5000);

        for (let i = 0; i < 10 && !state.stopped; i += 1) {
          await page.evaluate(() => window.scrollBy(0, 200));
          await sleep(500);
        }

        if (state.stopped) break;

        console.log("[BUMP] Checking button state...");
        const preClickCooldown = await detectBumpCooldown(page);
        if (preClickCooldown.hasCooldown) {
          await handleCooldownWait(preClickCooldown, "before click");
          continue;
        }
        if (preClickCooldown.buttonVisible) {
          console.log("[BUMP] Button ready - no cooldown");
        } else {
          console.log("[BUMP] No cooldown detected; waiting for bump button...");
        }

        const bumpButton = await page
          .waitForSelector("#managePublishAd", {
            visible: true,
            timeout: 15000
          })
          .catch(() => null);
        if (!bumpButton) {
          const retryDelayMs = getConfiguredDelayMs();
          const hint = preClickCooldown?.noButtonHint
            ? ` Hint: ${preClickCooldown.noButtonHint}`
            : "";
          console.log(
            `[BUMP] Bump button not found. Using configured retry window: ${formatDuration(
              retryDelayMs
            )} (${retryDelayMs} ms).${hint}`
          );
          await scheduleNextBump(retryDelayMs, {
            lastRunAt: account.lastBumpAt || new Date()
          });
          await waitForScheduledDelay(retryDelayMs);
          continue;
        }

        console.log("[BUMP] Clicking Bump to Top...");
        await Promise.all([
          page
            .waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 45000
            })
            .catch(() => null),
          bumpButton.click()
        ]);
        await sleep(2000);
        console.log("[BUMP] Bump button clicked");

        const popupCooldown = await detectCooldownPopup(page);
        if (popupCooldown.hasCooldown) {
          console.log("[BUMP] Cooldown popup detected after click attempt.");
          if (!popupCooldown.clickedOk) {
            await page
              .evaluate(() => {
                const candidates = Array.from(
                  document.querySelectorAll("button[type='button'], button, [role='button'], .close")
                );
                const closeButton = candidates.find((node) => {
                  const text = String(node.textContent || "")
                    .trim()
                    .toLowerCase();
                  return text === "ok" || text === "close" || text === "x";
                });
                if (closeButton) closeButton.click();
              })
              .catch(() => null);
          }

          await returnToPostsList(page).catch(() => null);
          await handleCooldownWait(popupCooldown, "cooldown popup after click");
          await returnToPostsList(page).catch(() => null);
          continue;
        }

        const postClickCooldown = await detectBumpCooldown(page);
        if (postClickCooldown.hasCooldown) {
          console.log("[BUMP] Cooldown detected after click attempt.");
          await page
            .evaluate(() => {
              const candidates = Array.from(
                document.querySelectorAll("button, [role='button'], .close")
              );
              const closeButton = candidates.find((node) => {
                const text = String(node.textContent || "")
                  .trim()
                  .toLowerCase();
                return (
                  text === "close" ||
                  text === "ok" ||
                  text === "x" ||
                  text.includes("dismiss")
                );
              });
              if (closeButton) closeButton.click();
            })
            .catch(() => null);

          await handleCooldownWait(postClickCooldown, "after click");
          continue;
        }

        await returnToPostsList(page);
        await assertAccountNotBanned(page, account, state, { ip });

        const bumpedAt = new Date();
        bumpCount += 1;
        await saveCookies(page, account).catch((error) => {
          console.warn(
            `[COOKIES] Save failed after bump for ${account.email}: ${error.message}`
          );
        });

        account.lastBumpAt = bumpedAt;
        await Account.findByIdAndUpdate(account._id, {
          status: "bumping",
          lastBumpAt: bumpedAt,
          totalBumpsToday: bumpCount,
          waitingUntil: null,
          cooldownMinutes: null
        }).catch(() => null);

        console.log("[BUMP] Bump success");
        const { baseInterval, randomMin, randomMax } = currentBumpConfig;
        const delayMs = calculateRegularDelayMs(baseInterval, randomMin, randomMax);
        await scheduleNextBump(delayMs, { lastRunAt: bumpedAt });
        await logActivity({
          level: "success",
          message: `\uD83D\uDFE2 ${account.email}\nBump successful\nNext in ${formatDurationCompact(
            delayMs
          )}\nProxy: ${proxyLabel}`,
          ip,
          email: account.email,
          accountId: account._id,
          metadata: {
            proxy: proxyLabel,
            bumpedAt,
            nextDelayMs: delayMs
          }
        }).catch(() => null);
        await waitForScheduledDelay(delayMs);
      } catch (error) {
        if (state.stopped || page.isClosed()) break;
        if (String(error?.type || "").toLowerCase() === "banned") {
          throw error;
        }
        console.error(`[BUMP] Cycle failed for ${account.email}:`, error.message);
        const retryDelayMs = getConfiguredDelayMs();
        console.log(
          `[BUMP] Scheduling retry using configured window: ${formatDuration(
            retryDelayMs
          )} (${retryDelayMs} ms)`
        );
        await scheduleNextBump(retryDelayMs, {
          lastRunAt: account.lastBumpAt || new Date()
        });
        await waitForScheduledDelay(retryDelayMs);
      }
    }
  } finally {
    stopBumpWatchdog();
    clearScheduledNextBump();
  }

  if (!state.stopped) {
    const finalStatus =
      loopExitReason === "runtime_window_closed" ? "paused" : "completed";
    const finalStep =
      loopExitReason === "runtime_window_closed"
        ? "outside_runtime_window"
        : "completed";

    await updateStatus(account._id, finalStatus, {
      ip,
      email: account.email
    }).catch(() => null);
    state.currentStatus = finalStatus;
    setWorkerStep(state, finalStep, page);
    await Account.findByIdAndUpdate(account._id, {
      status: finalStatus,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      waitingUntil: null
    }).catch(() => null);
  }
}

async function startWorker(account, options = {}) {
  const ip = options?.ip || "";
  const onExit = typeof options?.onExit === "function" ? options.onExit : null;
  const selfTestMode = Boolean(
    toBoolean(options?.selfTest, false) || getSelfTestConfig(account).enabled
  );
  const state = {
    stopped: false,
    loopPromise: null,
    activeAnnounced: false,
    heartbeatTimer: null,
    bumpWatchdogTimer: null,
    nextBumpAtMs: null,
    forceCycle: false,
    currentStep: "initializing",
    currentStatus: "starting",
    currentUrl: ""
  };
  let browser = null;
  let page = null;
  let browserClosed = false;
  let exitNotified = false;

  const notifyExit = async (error = null) => {
    if (exitNotified) return;
    exitNotified = true;

    if (onExit) {
      try {
        await onExit(error);
      } catch (notifyError) {
        console.error("[WORKER] onExit callback failed:", notifyError.message);
      }
    }
  };

  const closeBrowser = async () => {
    if (browserClosed) return;
    browserClosed = true;
    stopWorkerHeartbeat(account, state);
    if (state.bumpWatchdogTimer) {
      clearInterval(state.bumpWatchdogTimer);
      state.bumpWatchdogTimer = null;
    }

    if (page?._cleanupProxy) {
      try {
        await page._cleanupProxy();
      } catch (proxyError) {
        console.error("[PROXY] Cleanup error:", proxyError.message);
      }
    }

    if (!browser) {
      return;
    }

    try {
      if (typeof browser.isConnected === "function") {
        if (browser.isConnected()) {
          await browser.close();
        }
      } else {
        await browser.close();
      }
    } catch (browserError) {
      console.error("[BROWSER] Close failed:", browserError.message);
    }
  };

  const beginBumpLoop = async () => {
    if (state.stopped || state.loopPromise) {
      return;
    }

    if (!selfTestMode) {
      setWorkerStep(state, "opening_posts_list", page);

      if (!isPostsListUrl(page.url())) {
        await page.goto(POSTS_LIST_URL, {
          waitUntil: "networkidle2",
          timeout: 90000
        });
      }

      if (!isPostsListUrl(page.url())) {
        throw createWorkerError(
          "login_failed",
          `Did not reach posts list for ${account.email}. URL: ${page.url()}`
        );
      }

      await assertAccountNotBanned(page, account, state, { ip });
    } else {
      setWorkerStep(state, "self_test_mode", page);
      console.log(`[BUMP][SELF-TEST] Starting simulated bump loop for ${account.email}`);
    }

    await updateStatus(account._id, "active", {
      ip,
      email: account.email
    }).catch(() => null);
    state.currentStatus = "active";
    setWorkerStep(state, "ready_for_bumping", page);
    await Account.findByIdAndUpdate(account._id, {
      status: "active",
      waitingUntil: null
    }).catch(() => null);

    if (!state.activeAnnounced) {
      state.activeAnnounced = true;
      const proxyLabel = resolveProxyLabel(account, ip);
      await logActivity({
        level: "success",
        message: `✅ Account started | ${account.email}`,
        ip,
        email: account.email,
        accountId: account._id,
        metadata: {
          proxy: proxyLabel
        }
      }).catch(() => null);

      await logActivity({
        level: "success",
        message: `🌐 Proxy used | ${account.email} | proxy ${proxyLabel}`,
        ip,
        email: account.email,
        accountId: account._id,
        metadata: {
          proxy: proxyLabel
        }
      }).catch(() => null);
    }

    state.loopPromise = startBumpLoop(page, account, state, { ip })
      .catch(async (error) => {
        if (!state.stopped) {
          setWorkerStep(state, "bump_loop_error", page);
          console.error(`[BUMP] Loop crashed for ${account.email}:`, error.message);
          await notifyExit(
            createWorkerError(
              inferWorkerErrorType(error?.message),
              `Bump loop crashed: ${error.message || "Unknown bump loop error"}`,
              error
            )
          );
        }
      })
      .finally(async () => {
        if (!state.stopped) {
          state.stopped = true;
        }
        setWorkerStep(state, "stopping", page);
        await closeBrowser();
        await notifyExit();
      });
  };

  try {
    state.currentStatus = "starting";
    setWorkerStep(state, "starting_worker", page);
    await updateStatus(account._id, "starting", {
      ip,
      email: account.email
    }).catch(() => null);
    await Account.findByIdAndUpdate(account._id, {
      status: "starting"
    }).catch(() => null);

    try {
      const launched = await launchStealthBrowser(account);
      browser = launched.browser;
      page = launched.page;
      setWorkerStep(state, "browser_launched", page);
      startWorkerHeartbeat(account, state, page);
    } catch (launchError) {
      const launchType = inferWorkerErrorType(launchError?.message);
      throw createWorkerError(
        launchType === "login_failed" ? "unknown" : launchType,
        `Browser launch failed: ${launchError.message || "Unknown launch error"}`,
        launchError
      );
    }

    let loggedIn = false;
    let awaitingVerification = false;

    const verificationHooks = {
      ip,
      state,
      onVerified: async () => {
        await beginBumpLoop();
      },
      onTimeout: async () => {
        if (state.stopped) return;
        state.stopped = true;
        await closeBrowser();
        await notifyExit(
          createWorkerError(
            "login_failed",
            `Verification code timeout for ${account.email}`
          )
        );
      },
      onFailure: async (reason = "Verification failed") => {
        if (state.stopped) return;
        state.stopped = true;
        await closeBrowser();
        await notifyExit(
          createWorkerError("login_failed", `${reason} for ${account.email}`)
        );
      }
    };

    if (selfTestMode) {
      console.log(
        `[BUMP][SELF-TEST] Login/cookie flow skipped for ${account.email}`
      );
      await beginBumpLoop();

      return {
        stop: async () => {
          if (state.stopped) return;
          state.stopped = true;
          state.currentStatus = "stopped";
          setWorkerStep(state, "stopping", page);
          clearPendingVerificationSession(account._id);
          await closeBrowser();
          await notifyExit();
          console.log(`Worker stopped for ${account.email}`);
        }
      };
    }

    const loadedCookies = await loadCookies(page, account);
    if (loadedCookies) {
      setWorkerStep(state, "validating_cookie_session", page);
      console.log(`[COOKIES] Loaded cookies, validating session for ${account.email}`);
      loggedIn = await validateCookies(page, account, state, { ip });
      if (loggedIn) {
        console.log(
          `[LOGIN] Session restored via cookies, skipping login for ${account.email}`
        );
      } else {
        console.log(`[LOGIN] Cookies expired for ${account.email}, doing full login`);
      }
    }

    if (!loggedIn) {
      setWorkerStep(state, "performing_full_login", page);
      console.log(`[LOGIN] Full login required for ${account.email}`);
      const loginResult = await performFullLogin(page, account, verificationHooks);

      if (loginResult === "awaiting_verification") {
        awaitingVerification = true;
        state.currentStatus = "awaiting_verification_code";
        setWorkerStep(state, "awaiting_verification_code", page);
      } else if (loginResult === true) {
        if (isPostsListUrl(page.url())) {
          await assertAccountNotBanned(page, account, state, { ip });
          loggedIn = true;
        } else {
          loggedIn = await validateCookies(page, account, state, { ip });
        }
        if (loggedIn) {
          await saveCookies(page, account).catch((error) => {
            console.warn(
              `[COOKIES] Save failed after login for ${account.email}: ${error.message}`
            );
          });
        }
      } else {
        throw createWorkerError("login_failed", `Login failed for ${account.email}`);
      }
    }

    if (!awaitingVerification && !loggedIn) {
      throw createWorkerError(
        "login_failed",
        `Session validation failed for ${account.email}`
      );
    }

    if (awaitingVerification) {
      console.log(
        `[VERIFICATION] Waiting for dashboard verification code for ${account.email}`
      );
      return {
        stop: async () => {
          if (state.stopped) return;
          state.stopped = true;
          state.currentStatus = "stopped";
          setWorkerStep(state, "stopping", page);
          clearPendingVerificationSession(account._id);
          await closeBrowser();
          await notifyExit();
          console.log(`Worker stopped for ${account.email}`);
        }
      };
    }

    await logActivity({
      level: "success",
      message: `✅ Login success | ${account.email}`,
      ip,
      email: account.email,
      accountId: account._id,
      metadata: {
        proxy: resolveProxyLabel(account, ip)
      }
    }).catch(() => null);

    await beginBumpLoop();

    return {
      stop: async () => {
        if (state.stopped) return;
        state.stopped = true;
        state.currentStatus = "stopped";
        setWorkerStep(state, "stopping", page);
        clearPendingVerificationSession(account._id);
        await closeBrowser();
        await notifyExit();
        console.log(`Worker stopped for ${account.email}`);
      }
    };
  } catch (error) {
    const normalizedError = normalizeWorkerError(error);
    const loginFailureTypes = new Set(["login_failed", "credentials_invalid"]);
    if (loginFailureTypes.has(normalizedError.type)) {
      await logActivity({
        level: "error",
        message: `❌ Login failed | ${account.email} | reason: ${toShortReason(
          normalizedError.message,
          "unknown"
        )}`,
        ip,
        email: account.email,
        accountId: account._id,
        metadata: {
          errorType: normalizedError.type,
          error: normalizedError.message
        }
      }).catch(() => null);
    }

    state.stopped = true;
    state.currentStatus = normalizedError.type === "banned" ? "banned" : "error";
    setWorkerStep(
      state,
      normalizedError.type === "banned" ? "banned_detected" : "worker_error",
      page
    );
    await closeBrowser();
    await notifyExit(error);
    throw createWorkerError(
      normalizedError.type,
      normalizedError.message,
      error
    );
  }
}

async function stopWorker(worker) {
  if (worker && worker.stop) {
    await worker.stop();
  }
}

let queueProcessing = false;

function getActiveWorkerCount() {
  return runningWorkers.size + startingLocks.size;
}

async function clearWorkerRetryState(accountId) {
  await updateWorkerState(accountId, {
    failureCount: 0,
    lastErrorMessage: null,
    lastErrorAt: null,
    nextRetryAt: null,
    blockedReason: null
  });
}

async function handleWorkerFailure(account, error, options = {}) {
  const accountId = normalizeAccountId(account);
  if (!accountId) return;

  const ip = options?.ip || "";
  const scopedUserId = normalizeUserId(options?.userId || account?.userId);
  const normalizedError = normalizeWorkerError(error);
  const status = mapErrorTypeToStatus(normalizedError.type);
  const latest = await Account.findOne(
    scopedUserId
      ? {
          _id: accountId,
          userId: scopedUserId
        }
      : { _id: accountId }
  )
    .select("email autoRestartCrashed workerState")
    .lean();
  if (!latest) return;
  const email = latest?.email || account.email;
  const autoRestartEnabled =
    latest?.autoRestartCrashed === undefined
      ? account.autoRestartCrashed !== false
      : latest.autoRestartCrashed !== false;

  deleteRunningWorker(account, { userId: scopedUserId });
  startingLocks.delete(accountId);

  if (normalizedError.type === "banned") {
    clearRetryTimer(accountId);
    await updateWorkerState(
      accountId,
      {
        lastErrorMessage: normalizedError.message,
        lastErrorAt: new Date(),
        nextRetryAt: null
      },
      {
        status: "banned"
      }
    );
    await updateStatus(accountId, "banned", { ip, email }).catch(() => null);
    await processQueue();
    return;
  }

  if (normalizedError.type === "awaiting_2fa") {
    clearRetryTimer(accountId);
    await updateWorkerState(
      accountId,
      {
        lastErrorMessage: normalizedError.message,
        lastErrorAt: new Date(),
        nextRetryAt: null
      },
      {
        status: "awaiting_2fa"
      }
    );
    await updateStatus(accountId, "awaiting_2fa", { ip, email }).catch(() => null);
    await processQueue();
    return;
  }

  if (normalizedError.type === "credentials_invalid") {
    const uiMessage = "Acc Pass Wrong";
    const blockedAt = new Date();
    clearRetryTimer(accountId);

    await updateWorkerState(
      accountId,
      {
        failureCount: 0,
        lastErrorMessage: uiMessage,
        lastErrorAt: blockedAt,
        nextRetryAt: null,
        blockedReason: uiMessage
      },
      {
        status: "login_failed"
      }
    );
    await updateStatus(accountId, "login_failed", { ip, email }).catch(() => null);

    emitAccountUpdate(
      account,
      {
        status: "login_failed",
        workerState: {
          failureCount: 0,
          lastErrorMessage: uiMessage,
          lastErrorAt: blockedAt.toISOString(),
          nextRetryAt: null,
          blockedReason: uiMessage
        },
        authMessage: uiMessage
      }
    );

    await logActivity({
      level: "error",
      message: `Login credentials invalid: ${email}`,
      ip,
      email,
      accountId,
      metadata: {
        errorType: normalizedError.type,
        error: normalizedError.message,
        telegram: false
      }
    }).catch(() => null);

    await processQueue();
    return;
  }

  const previousFailures = Number(latest?.workerState?.failureCount || 0);
  const failureCount = previousFailures + 1;
  const lastErrorAt = new Date();

  if (failureCount >= FAILURE_LIMIT) {
    clearRetryTimer(accountId);
    await updateWorkerState(
      accountId,
      {
        failureCount,
        lastErrorMessage: normalizedError.message,
        lastErrorAt,
        nextRetryAt: null,
        blockedReason: "Too many consecutive failures"
      },
      {
        status: "blocked"
      }
    );
    await updateStatus(accountId, "blocked", { ip, email }).catch(() => null);
    console.error(
      "[WORKER] Account blocked after 5 failures. Manual restart required."
    );
    await logActivity({
      level: "error",
      message: `💥 Worker crashed | ${email} | blocked after ${failureCount} failures`,
      ip,
      email,
      accountId,
      metadata: {
        failureCount,
        errorType: normalizedError.type,
        error: normalizedError.message
      }
    }).catch(() => null);
    await processQueue();
    return;
  }

  const retryDelayMs = calculateRetryDelayMs(failureCount);
  const nextRetryAt = new Date(Date.now() + retryDelayMs);

  await updateWorkerState(
    accountId,
    {
      failureCount,
      lastErrorMessage: normalizedError.message,
      lastErrorAt,
      nextRetryAt,
      blockedReason: null
    },
    {
      status
    }
  );
  await updateStatus(accountId, status, { ip, email }).catch(() => null);

  if (!autoRestartEnabled) {
    clearRetryTimer(accountId);
    await updateWorkerState(accountId, {
      nextRetryAt: null
    });
    await logActivity({
      level: "warning",
      message: `💥 Worker crashed | ${email} | auto-restart disabled`,
      ip,
      email,
      accountId,
      metadata: {
        failureCount,
        errorType: normalizedError.type,
        error: normalizedError.message
      }
    }).catch(() => null);
    await processQueue();
    return;
  }

  const retrySeconds = Math.ceil(retryDelayMs / 1000);
  console.warn(
    `[WORKER] Attempt ${failureCount} failed. Retrying in ${retrySeconds} seconds.`
  );

  await logActivity({
    level: "warning",
    message: `💥 Worker crashed | ${email} | restarting in ${retrySeconds} sec`,
    ip,
    email,
    accountId,
    metadata: {
      failureCount,
      retryDelayMs,
      errorType: normalizedError.type,
      error: normalizedError.message
    }
  }).catch(() => null);

  clearRetryTimer(accountId);
  const retryTimer = setTimeout(async () => {
    retryTimers.delete(accountId);
    if (isStopRequested(accountId)) return;

    const latestAccount = await Account.findOne(
      scopedUserId
        ? {
            _id: accountId,
            userId: scopedUserId
          }
        : { _id: accountId }
    );
    if (!latestAccount || latestAccount.workerState?.blockedReason) {
      return;
    }

    await requestStart(latestAccount, { ip, userId: scopedUserId });
  }, retryDelayMs);

  retryTimers.set(accountId, retryTimer);
  await processQueue();
}

async function handleWorkerExit(accountId, account, error, options = {}) {
  const key = String(accountId);
  const ip = options?.ip || "";
  const email = account?.email;
  const scopedUserId = normalizeUserId(options?.userId || account?.userId);

  deleteRunningWorker(account || key, { userId: scopedUserId });

  if (isStopRequested(key)) {
    clearRetryTimer(key);
    clearStopRequest(key);
    await updateWorkerState(
      key,
      {
        nextRetryAt: null
      },
      {
        status: "stopped"
      }
    );
    await updateStatus(key, "stopped", { ip, email }).catch(() => null);
    await processQueue();
    return;
  }

  if (error) {
    const latestAccount = await Account.findOne(
      scopedUserId
        ? {
            _id: key,
            userId: scopedUserId
          }
        : { _id: key }
    );
    if (latestAccount) {
      await handleWorkerFailure(latestAccount, error, {
        ip,
        userId: scopedUserId
      });
      return;
    }
  }

  await processQueue();
}

async function startAccountInternal(account, options = {}) {
  const accountId = normalizeAccountId(account);
  if (!accountId) return;

  const ip = options?.ip || "";
  const scopedUserId = normalizeUserId(options?.userId || account?.userId);
  if (hasRunningWorker(account, { userId: scopedUserId }) || startingLocks.has(accountId)) {
    return;
  }

  if (isStopRequested(accountId)) {
    return;
  }

  startingLocks.add(accountId);
  let startConfirmed = false;

  try {
    if (!isWithinRuntimeWindow(account.runtimeWindow, account.timezone)) {
      await logActivity({
        level: "warning",
        message: `Start skipped outside runtime window: ${account.email}`,
        ip,
        email: account.email,
        accountId
      }).catch(() => null);
      return;
    }

    await updateStatus(accountId, "starting", {
      ip,
      email: account.email
    }).catch(() => null);

    const worker = await startWorker(account, {
      ip,
      onExit: async (exitError) => {
        if (!startConfirmed) return;
        await handleWorkerExit(accountId, account, exitError, {
          ip,
          userId: scopedUserId
        });
      }
    });

    startConfirmed = true;

    if (!worker) {
      throw createWorkerError(
        "unknown",
        `Worker failed to initialize for ${account.email}`
      );
    }

    if (isStopRequested(accountId)) {
      await stopWorker(worker);
      return;
    }

    setRunningWorker(account, worker, {
      startedAt: Date.now()
    });
    clearRetryTimer(accountId);
    await clearWorkerRetryState(accountId);
    await logActivity({
      level: "info",
      message: `Started thread: ${account.email}`,
      ip,
      email: account.email,
      accountId
    }).catch(() => null);
  } catch (error) {
    await handleWorkerFailure(account, error, {
      ip,
      userId: scopedUserId
    });
  } finally {
    startingLocks.delete(accountId);
    await processQueue();
  }
}

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  try {
    while (getActiveWorkerCount() < MAX_CONCURRENCY && startQueue.length > 0) {
      const next = startQueue.shift();
      if (!next?.accountId) continue;

      queuedAccounts.delete(next.queueKey || next.accountId);

      if (
        hasRunningWorker(next.accountId, { userId: next.userId }) ||
        startingLocks.has(next.accountId)
      ) {
        continue;
      }

      if (isStopRequested(next.accountId)) {
        continue;
      }

      const account = await Account.findOne(
        next.userId
          ? {
              _id: next.accountId,
              userId: next.userId
            }
          : { _id: next.accountId }
      );
      if (!account) {
        continue;
      }

      if (account.workerState?.blockedReason) {
        continue;
      }

      await startAccountInternal(account, {
        ip: next.ip,
        userId: next.userId || account.userId
      });
    }
  } finally {
    queueProcessing = false;
  }
}

async function requestStart(accountOrId, options = {}) {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return;

  const scopedUserId = normalizeUserId(
    options?.userId ||
      (typeof accountOrId === "object" && accountOrId ? accountOrId.userId : "")
  );
  if (hasRunningWorker(accountOrId, { userId: scopedUserId }) || startingLocks.has(accountId)) {
    return;
  }

  const queueKey = buildWorkerKey(scopedUserId, accountId);
  if (queuedAccounts.has(queueKey) || queuedAccounts.has(accountId)) {
    return;
  }

  clearStopRequest(accountId);

  const account =
    typeof accountOrId === "object" && accountOrId?._id
      ? accountOrId
      : await Account.findOne(
          scopedUserId
            ? {
                _id: accountId,
                userId: scopedUserId
              }
            : { _id: accountId }
        );

  if (!account) return;
  const accountUserId = normalizeUserId(account.userId);
  if (scopedUserId && accountUserId && scopedUserId !== accountUserId) {
    return;
  }
  if (account.workerState?.blockedReason) return;
  if (String(account.status || "").toLowerCase() === "banned") {
    console.warn(`[WORKER] Start skipped for banned account: ${account.email}`);
    return;
  }

  const shouldResetRuntimeFields = Boolean(options?.resetRuntimeFields);
  if (shouldResetRuntimeFields) {
    await updateWorkerState(
      accountId,
      {
        failureCount: 0,
        lastErrorMessage: null,
        lastErrorAt: null,
        nextRetryAt: null,
        blockedReason: null
      },
      {
        status: "starting",
        waitingUntil: null,
        nextBumpAt: null,
        nextBumpDelayMs: null,
        cooldownMinutes: null,
        lastCooldownDetected: null
      }
    );
  }

  const startPatch = {
    status: "starting",
    waitingUntil: null,
    nextBumpAt: null,
    nextBumpDelayMs: null,
    cooldownMinutes: null,
    workerState: {
      nextRetryAt: null
    }
  };

  if (options?.emitPendingConnectionTest) {
    startPatch.connectionTest = buildPendingConnectionTest(account.connectionTest);
  }

  emitAccountUpdate(account, startPatch);

  if (getActiveWorkerCount() >= MAX_CONCURRENCY) {
    queueStart(accountId, {
      ip: options?.ip || "",
      userId: accountUserId
    });
    return;
  }

  removeFromQueue(accountId, { userId: accountUserId });
  await startAccountInternal(account, {
    ...options,
    userId: accountUserId
  });
}

async function recoverOverdueAccounts() {
  if (recoveryInProgress) {
    return;
  }
  recoveryInProgress = true;

  try {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const staleStartCutoff = new Date(nowMs - STALE_START_RECOVERY_MS);

    const candidates = await Account.find({
      $or: [
        {
          status: "waiting_cooldown",
          $or: [
            { nextBumpAt: { $ne: null, $lte: now } },
            { waitingUntil: { $ne: null, $lte: now } }
          ]
        },
        {
          status: { $in: ["starting", "restarting"] },
          updatedAt: { $lte: staleStartCutoff }
        }
      ]
    })
      .select("_id email userId status nextBumpAt waitingUntil updatedAt workerState")
      .lean();

    for (const account of candidates) {
      const accountId = normalizeAccountId(account);
      const userId = normalizeUserId(account?.userId);

      if (!accountId) continue;
      if (account?.workerState?.blockedReason) continue;
      if (hasRunningWorker(accountId, { userId }) || startingLocks.has(accountId)) {
        continue;
      }
      if (isStopRequested(accountId)) continue;

      const queueKey = buildWorkerKey(userId, accountId);
      if (queuedAccounts.has(queueKey) || queuedAccounts.has(accountId)) {
        continue;
      }

      const reason =
        String(account?.status || "").toLowerCase() === "waiting_cooldown"
          ? "cooldown overdue"
          : "stale startup status";

      console.log(
        `[RECOVERY] Re-queueing ${account?.email || accountId} (${reason})`
      );
      requestStart(account, { userId }).catch((startError) => {
        console.error(
          `[RECOVERY] Failed to re-queue ${account?.email || accountId}:`,
          startError.message
        );
      });
    }
  } catch (error) {
    console.error("[RECOVERY] Overdue account recovery failed:", error.message);
  } finally {
    recoveryInProgress = false;
  }
}
async function requestStop(accountId, options = {}) {
  const key = normalizeAccountId(accountId);
  if (!key) return;

  const scopedUserId = normalizeUserId(
    options?.userId ||
      (typeof accountId === "object" && accountId ? accountId.userId : "")
  );
  const ip = options?.ip || "";
  const runningEntry = getRunningWorkerEntry(key, { userId: scopedUserId });
  const latestAccount = await Account.findOne(
    scopedUserId
      ? {
          _id: key,
          userId: scopedUserId
        }
      : { _id: key }
  )
    .select("email userId")
    .lean()
    .catch(() => null);
  if (scopedUserId && !latestAccount && !runningEntry) {
    return;
  }
  const effectiveUserId = normalizeUserId(latestAccount?.userId || scopedUserId);
  const email = latestAccount?.email || String(options?.email || key);
  const timeoutMsRaw = Number(options?.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.floor(timeoutMsRaw)
      : 0;
  const forceClearStopRequest = Boolean(options?.forceClearStopRequest);
  stopRequests.add(key);
  removeFromQueue(key, { userId: effectiveUserId });
  clearRetryTimer(key);

  if (runningEntry?.entry?.worker) {
    const stopPromise = stopWorker(runningEntry.entry.worker).catch(() => null);
    if (timeoutMs > 0) {
      const timedOut = await Promise.race([
        stopPromise.then(() => false),
        sleep(timeoutMs).then(() => true)
      ]);
      if (timedOut) {
        console.warn(
          `[WORKER] Stop timed out after ${timeoutMs}ms for account ${key}. Continuing shutdown.`
        );
      }
    } else {
      await stopPromise;
    }
    deleteRunningWorker(key, { userId: effectiveUserId });
  }

  const shouldClearStopRequest =
    !startingLocks.has(key) && !hasRunningWorker(key, { userId: effectiveUserId });
  if (shouldClearStopRequest || forceClearStopRequest) {
    clearStopRequest(key);
  }

  await updateWorkerState(
    key,
    {
      nextRetryAt: null
    },
    {
      status: "stopped"
    }
  );
  await updateStatus(key, "stopped", { ip, email }).catch(() => null);
  await logActivity({
    level: "warning",
    message: `🛑 Worker stopped | ${email}`,
    ip,
    email,
    accountId: key
  }).catch(() => null);
  emitAccountUpdate(
    latestAccount || key,
    {
      status: "stopped",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null
    },
    {},
    effectiveUserId
  );
  await processQueue();
}

async function restartAccount(accountOrId, options = {}) {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return null;

  const scopedUserId = normalizeUserId(
    options?.userId ||
      (typeof accountOrId === "object" && accountOrId ? accountOrId.userId : "")
  );
  const ip = options?.ip || "";
  const restartDelayMsRaw = Number(options?.restartDelayMs);
  const restartDelayMs =
    Number.isFinite(restartDelayMsRaw) && restartDelayMsRaw >= 0
      ? Math.floor(restartDelayMsRaw)
      : 3000;
  const stopTimeoutMsRaw = Number(options?.stopTimeoutMs);
  const stopTimeoutMs =
    Number.isFinite(stopTimeoutMsRaw) && stopTimeoutMsRaw > 0
      ? Math.floor(stopTimeoutMsRaw)
      : 5000;

  const account =
    typeof accountOrId === "object" && accountOrId?._id
      ? accountOrId
      : await Account.findOne(
          scopedUserId
            ? {
                _id: accountId,
                userId: scopedUserId
              }
            : { _id: accountId }
        );
  if (!account) {
    return null;
  }

  const email = String(account.email || options?.email || accountId);

  emitAccountUpdate(account, {
    status: "restarting",
    waitingUntil: null,
    nextBumpAt: null,
    nextBumpDelayMs: null,
    cooldownMinutes: null,
    connectionTest: buildPendingConnectionTest(account.connectionTest)
  });

  await updateWorkerState(
    accountId,
    {
      failureCount: 0,
      lastErrorMessage: null,
      lastErrorAt: null,
      nextRetryAt: null,
      blockedReason: null
    },
    {
      status: "restarting",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null,
      lastCooldownDetected: null
    }
  );
  await updateStatus(accountId, "restarting", { ip, email }).catch(() => null);

  await requestStop(accountId, {
    ip,
    userId: account.userId,
    timeoutMs: stopTimeoutMs,
    forceClearStopRequest: true
  });

  await updateWorkerState(
    accountId,
    {
      nextRetryAt: null
    },
    {
      status: "restarting",
      waitingUntil: null,
      nextBumpAt: null,
      nextBumpDelayMs: null,
      cooldownMinutes: null
    }
  );
  await updateStatus(accountId, "restarting", { ip, email }).catch(() => null);
  emitAccountUpdate(account, {
    status: "restarting",
    waitingUntil: null,
    nextBumpAt: null,
    nextBumpDelayMs: null,
    cooldownMinutes: null
  });

  if (restartDelayMs > 0) {
    await sleep(restartDelayMs);
  }

  const latest = await Account.findOne({
    _id: accountId,
    userId: account.userId
  });
  if (!latest) {
    return null;
  }

  try {
    await requestStart(latest, {
      ip,
      userId: account.userId,
      resetRuntimeFields: true,
      emitPendingConnectionTest: true
    });
    console.log(`[RESTART] ${email} restarted successfully`);
    return {
      success: true,
      accountId: String(accountId),
      status: "starting"
    };
  } catch (error) {
    const message = String(error?.message || "Restart failed");
    console.error(`[RESTART] ${email} failed: ${message}`);
    await updateWorkerState(
      accountId,
      {
        lastErrorMessage: message,
        lastErrorAt: new Date()
      },
      {
        status: "crashed"
      }
    );
    await updateStatus(accountId, "crashed", { ip, email }).catch(() => null);
    emitAccountUpdate(account, {
      status: "crashed",
      workerState: {
        lastErrorMessage: message
      }
    });
    await logActivity({
      level: "error",
      message: `💥 Worker crashed | ${email} | restart failed`,
      ip,
      email,
      accountId,
      metadata: {
        error: message
      }
    }).catch(() => null);
    throw error;
  }
}

async function startAll(accounts = []) {
  for (const account of accounts) {
    await requestStart(account, {
      userId: account?.userId
    });
  }
  await processQueue();
}

async function stopAll(options = {}) {
  const scopedUserId = normalizeUserId(options?.userId);
  let retryAccountIds = Array.from(retryTimers.keys());
  let startingAccountIds = Array.from(startingLocks.values());

  if (scopedUserId) {
    const candidateIds = Array.from(new Set([...retryAccountIds, ...startingAccountIds]));
    if (candidateIds.length > 0) {
      const scopedRows = await Account.find({
        _id: { $in: candidateIds },
        userId: scopedUserId
      })
        .select("_id")
        .lean();
      const scopedSet = new Set(scopedRows.map((row) => String(row._id)));
      retryAccountIds = retryAccountIds.filter((id) => scopedSet.has(String(id)));
      startingAccountIds = startingAccountIds.filter((id) => scopedSet.has(String(id)));
    } else {
      retryAccountIds = [];
      startingAccountIds = [];
    }
  }

  const allIds = new Set([
    ...getRunningAccountIds({ userId: scopedUserId }),
    ...startQueue
      .filter((item) => !scopedUserId || normalizeUserId(item?.userId) === scopedUserId)
      .map((item) => String(item?.accountId || "")),
    ...retryAccountIds,
    ...startingAccountIds
  ]);

  for (let index = startQueue.length - 1; index >= 0; index -= 1) {
    const item = startQueue[index];
    if (!item) continue;
    if (scopedUserId && normalizeUserId(item.userId) !== scopedUserId) {
      continue;
    }
    startQueue.splice(index, 1);
    queuedAccounts.delete(item.queueKey || item.accountId);
  }

  await Promise.all(
    Array.from(allIds)
      .filter(Boolean)
      .map((accountId) =>
        requestStop(accountId, {
          userId: scopedUserId
        })
      )
  );
}

async function resetRetry(accountId, options = {}) {
  const key = normalizeAccountId(accountId);
  if (!key) return null;
  const scopedUserId = normalizeUserId(options?.userId);

  clearRetryTimer(key);
  removeFromQueue(key, { userId: scopedUserId });

  const account = await Account.findOne(
    scopedUserId
      ? {
          _id: key,
          userId: scopedUserId
        }
      : { _id: key }
  );
  if (!account) {
    return null;
  }

  await clearWorkerRetryState(key);

  if (String(account.status || "").toLowerCase() === "blocked") {
    await updateWorkerState(
      key,
      {},
      {
        status: "stopped"
      }
    );
    await updateStatus(key, "stopped", { email: account.email }).catch(() => null);
  }

  return Account.findOne({
    _id: key,
    userId: account.userId
  });
}

function getWorkerStatus(options = {}) {
  const scopedUserId = normalizeUserId(options?.userId);
  const runningAccounts = getRunningAccountIds({ userId: scopedUserId });
  const queued =
    scopedUserId
      ? startQueue.filter((item) => normalizeUserId(item?.userId) === scopedUserId).length
      : startQueue.length;
  return {
    running: runningAccounts.length,
    queued,
    maxConcurrency: MAX_CONCURRENCY,
    runningAccounts
  };
}

// ========================================
// Device Verification Functions
// ========================================

async function submitVerificationCode(accountId, verificationCode) {
  const key = String(accountId || "");
  const session = pendingVerificationSessions.get(key);
  if (!session) {
    throw new Error("No active verification session found for this account");
  }

  const normalizedCode = String(verificationCode || "").trim();
  if (!normalizedCode) {
    throw new Error("Verification code is required");
  }

  const { page, email, account, ip, resumeBumping, onFailure } = session;

  try {
    if (!page || page.isClosed()) {
      throw new Error("Verification page is no longer available");
    }

    console.log(`[VERIFICATION] Submitting code for ${email}`);

    await page
      .evaluate(() => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const buttons = Array.from(
          document.querySelectorAll("button[type='button'], button, [role='button']")
        );
        const okButton = buttons.find((node) => normalize(node.textContent) === "ok");
        if (okButton) {
          okButton.click();
          return true;
        }
        return false;
      })
      .catch(() => false);

    await page.waitForSelector("#verificationCode", {
      visible: true,
      timeout: 15000
    });
    console.log("[VERIFICATION] Verification input detected");

    const codeInput =
      (await page.$("#verificationCode")) ||
      (await page.$("input[name='verificationCode']")) ||
      (await page.$(".phone-input-code"));
    if (!codeInput) {
      throw new Error("Verification code input field not found");
    }

    await codeInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await codeInput.type(normalizedCode, { delay: 120 });

    const submitButton =
      (await page.$("#device_verification_submit")) ||
      (await page.$("button[type='submit']")) ||
      (await page.$("input[type='submit']"));
    if (!submitButton) {
      throw new Error("Verification submit button not found");
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(
        () => null
      ),
      submitButton.click()
    ]);

    let currentUrl = page.url();
    console.log(`[VERIFICATION] Submit redirected to: ${currentUrl}`);

    if (isVerificationSuccessUrl(currentUrl)) {
      console.log("[VERIFICATION] Success confirmation page detected, clicking OK...");

      const clickedSuccessOk = await page
        .evaluate(() => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const candidates = Array.from(
            document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']")
          );
          const okButton = candidates.find((node) => {
            const id = normalize(node.id);
            const text = normalize(node.textContent || node.value || "");
            return id === "successful-device-verification" || text === "ok";
          });
          if (!okButton) return false;
          okButton.click();
          return true;
        })
        .catch(() => false);

      if (clickedSuccessOk) {
        await Promise.race([
          page
            .waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 20000
            })
            .catch(() => null),
          page
            .waitForFunction(() => window.location.href.includes("/users/posts/list"), {
              timeout: 20000
            })
            .catch(() => null)
        ]).catch(() => null);
      }

      currentUrl = page.url();
      console.log(`[VERIFICATION] After success confirmation: ${currentUrl}`);

      if (isVerificationSuccessUrl(currentUrl)) {
        await page
          .goto(POSTS_LIST_URL, {
            waitUntil: "networkidle2",
            timeout: 30000
          })
          .catch(() => null);
        currentUrl = page.url();
        console.log(`[VERIFICATION] After direct posts navigation: ${currentUrl}`);
      }
    }

    if (!isPostsListUrl(currentUrl) && isPhoneVerificationUrl(currentUrl)) {
      console.warn(
        `[VERIFICATION] Phone verification checkpoint detected for ${email}: ${currentUrl}`
      );

      // In some sessions this page is transient; try forcing posts list first.
      await page
        .goto(POSTS_LIST_URL, {
          waitUntil: "networkidle2",
          timeout: 30000
        })
        .catch(() => null);

      currentUrl = page.url();
      console.log(
        `[VERIFICATION] After phone checkpoint direct posts navigation: ${currentUrl}`
      );

      if (!isPostsListUrl(currentUrl)) {
        const waitingUntil = new Date(Date.now() + VERIFICATION_TIMEOUT_MS);

        await Account.findByIdAndUpdate(key, {
          status: "awaiting_2fa",
          verificationCurrentUrl: currentUrl,
          verificationRequestedAt: new Date(),
          waitingUntil
        }).catch(() => null);
        await updateStatus(key, "awaiting_2fa", { ip, email }).catch(() => null);

        emitAccountUpdate(account, {
          status: "awaiting_2fa",
          verificationCurrentUrl: currentUrl,
          waitingUntil: waitingUntil.toISOString()
        });

        // Keep session alive for one more code submit (do not fail/restart worker).
        const activeSession = pendingVerificationSessions.get(key);
        if (activeSession) {
          if (activeSession.expiryTimer) {
            clearTimeout(activeSession.expiryTimer);
          }

          activeSession.expiryTimer = setTimeout(async () => {
            const latestSession = pendingVerificationSessions.get(key);
            if (!latestSession) return;

            clearPendingVerificationSession(key);

            await Account.findByIdAndUpdate(key, {
              status: "login_failed",
              lastError: "Verification code timeout"
            }).catch(() => null);
            await updateStatus(key, "login_failed", {
              ip: latestSession.ip || ip,
              email: latestSession.email || email
            }).catch(() => null);

            if (typeof latestSession.onTimeout === "function") {
              await latestSession.onTimeout();
              return;
            }

            const sessionBrowser = latestSession.browser;
            if (sessionBrowser && typeof sessionBrowser.isConnected === "function") {
              if (sessionBrowser.isConnected()) {
                await sessionBrowser.close().catch(() => null);
              }
            } else if (sessionBrowser) {
              await sessionBrowser.close().catch(() => null);
            }
          }, VERIFICATION_TIMEOUT_MS);

          pendingVerificationSessions.set(key, activeSession);
        }

        return {
          success: true,
          status: "awaiting_2fa",
          message: "Additional phone verification required",
          requiresAdditionalVerification: true,
          finalUrl: currentUrl
        };
      }
    }

    if (!isPostsListUrl(currentUrl)) {
      clearPendingVerificationSession(key);
      await Account.findByIdAndUpdate(key, {
        status: "login_failed",
        lastError: `Verification failed - URL after submit: ${currentUrl}`
      }).catch(() => null);
      await updateStatus(key, "login_failed", { ip, email }).catch(() => null);

      if (typeof onFailure === "function") {
        await onFailure("Verification code was rejected");
      }

      return {
        success: false,
        message: "Verification failed",
        finalUrl: currentUrl
      };
    }

    clearPendingVerificationSession(key);

    await saveCookies(page, account).catch(() => null);

    await Account.findByIdAndUpdate(key, {
      status: "active",
      lastLoginAt: new Date(),
      verificationCompletedAt: new Date(),
      verificationRequestedAt: null,
      waitingUntil: null
    }).catch(() => null);
    await updateStatus(key, "active", { ip, email }).catch(() => null);

    if (typeof resumeBumping === "function") {
      await resumeBumping();
    }

    return {
      success: true,
      message: "Device verification completed successfully",
      finalUrl: currentUrl
    };
  } catch (error) {
    clearPendingVerificationSession(key);
    await Account.findByIdAndUpdate(key, {
      status: "login_failed",
      lastError: error.message
    }).catch(() => null);
    await updateStatus(key, "login_failed", {
      ip: session?.ip || "",
      email: session?.email || ""
    }).catch(() => null);

    if (typeof session?.onFailure === "function") {
      await session.onFailure("Verification submit failed");
    }

    throw error;
  }
}

async function startBumpAutomation(page, account) {
  console.log(`[BUMP] Starting automation for ${account.email}`);

  let bumpCount = 0;
  const maxBumps = Number(account.maxDailyBumps || 10);

  while (bumpCount < maxBumps) {
    if (!page || page.isClosed()) {
      console.log(`[BUMP] Page closed for ${account.email}, stopping automation`);
      return;
    }

    try {
      console.log(`[BUMP] Cycle ${bumpCount + 1}/${maxBumps}`);

      const currentUrl = page.url();
      if (!currentUrl.includes("/users/posts/list")) {
        console.log("[BUMP] Navigating to posts list...");
        await page.goto("https://megapersonals.eu/users/posts/list", {
          waitUntil: "networkidle2",
          timeout: 30000
        });
      }

      console.log("[BUMP] Waiting 5 seconds...");
      await sleep(5000);

      console.log("[BUMP] Scrolling for 10 seconds...");
      const scrollDuration = 10000;
      const scrollStep = 500;
      const scrollAmount = 300;
      const scrollIntervals = Math.floor(scrollDuration / scrollStep);

      for (let i = 0; i < scrollIntervals; i += 1) {
        await page.evaluate((amount) => {
          window.scrollBy(0, amount);
        }, scrollAmount);
        await sleep(scrollStep);
      }

      console.log("[BUMP] Looking for Bump to Top button...");
      await page.waitForSelector("#managePublishAd", {
        visible: true,
        timeout: 10000
      });

      const bumpButton = await page.$("#managePublishAd");
      if (!bumpButton) {
        console.warn("[BUMP] Bump button not found, skipping cycle");
        await sleep(60000);
        continue;
      }

      console.log("[BUMP] Clicking Bump to Top...");
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 30000
        }),
        bumpButton.click()
      ]);

      console.log(`[BUMP] Redirected to: ${page.url()}`);
      console.log("[BUMP] Waiting 10 seconds on bump page...");
      await sleep(10000);

      console.log("[BUMP] Returning to posts list...");
      await page.goto("https://megapersonals.eu/users/posts/list", {
        waitUntil: "networkidle2",
        timeout: 30000
      });

      bumpCount += 1;
      console.log(`[BUMP] Bump ${bumpCount} completed`);

      await Account.findByIdAndUpdate(account._id, {
        lastBumpAt: new Date(),
        totalBumpsToday: bumpCount,
        status: "active"
      });

      const randomDelayMs =
        (Number(account.baseInterval || 5) * 60 * 1000) +
        Math.floor(Math.random() * 2 * 60 * 1000);

      console.log(`[BUMP] Waiting ${Math.round(randomDelayMs / 60000)} minutes until next bump...`);
      await logNextBumpSchedule(account, randomDelayMs);
      await sleep(randomDelayMs);
    } catch (error) {
      console.error(`[BUMP] Error in cycle ${bumpCount + 1}:`, error.message);

      try {
        await page.screenshot({
          path: `bump-error-${account.email}-${Date.now()}.png`,
          fullPage: true
        });
      } catch (screenshotError) {
        console.error("[BUMP] Failed to save bump error screenshot:", screenshotError.message);
      }

      console.log("[BUMP] Waiting 2 minutes before retry...");
      await sleep(120000);
    }
  }

  console.log(`[BUMP] Daily bump limit reached (${maxBumps}) for ${account.email}`);
  await Account.findByIdAndUpdate(account._id, {
    status: "completed",
    lastBumpAt: new Date(),
    totalBumpsToday: bumpCount
  });
}

async function handleDeviceVerification(page, account, options = {}) {
  const accountId = String(account._id);
  const ip = options?.ip || "";

  try {
    console.log(`[VERIFICATION] Device verification page detected for ${account.email}`);

    await page
      .evaluate(() => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const buttons = Array.from(
          document.querySelectorAll("button[type='button'], button, [role='button']")
        );
        const okButton = buttons.find((node) => normalize(node.textContent) === "ok");
        if (okButton) {
          okButton.click();
          return true;
        }
        return false;
      })
      .then((clicked) => {
        if (clicked) {
          console.log("[VERIFICATION] Closed verification warning");
        }
      })
      .catch(() => null);

    await page.waitForSelector("#verificationCode", {
      visible: true,
      timeout: 20000
    });
    console.log("[VERIFICATION] Verification input detected");

    clearPendingVerificationSession(accountId);

    const waitingUntil = new Date(Date.now() + VERIFICATION_TIMEOUT_MS);
    await Account.findByIdAndUpdate(accountId, {
      status: "awaiting_verification_code",
      verificationRequestedAt: new Date(),
      waitingUntil
    }).catch(() => null);
    await updateStatus(accountId, "awaiting_verification_code", {
      ip,
      email: account.email
    }).catch(() => null);

    await emitToUserEvent(account.userId, "verification-required", {
      accountId,
      email: account.email,
      userId: String(account.userId || ""),
      timestamp: new Date().toISOString(),
      status: "awaiting_verification_code"
    }).catch(() => null);

    const expiryTimer = setTimeout(async () => {
      const activeSession = pendingVerificationSessions.get(accountId);
      if (!activeSession) return;

      clearPendingVerificationSession(accountId);

      await Account.findByIdAndUpdate(accountId, {
        status: "login_failed",
        lastError: "Verification code timeout"
      }).catch(() => null);
      await updateStatus(accountId, "login_failed", {
        ip: activeSession.ip || ip,
        email: activeSession.email || account.email
      }).catch(() => null);

      if (typeof activeSession.onTimeout === "function") {
        await activeSession.onTimeout();
        return;
      }

      const sessionBrowser = activeSession.browser;
      if (sessionBrowser && typeof sessionBrowser.isConnected === "function") {
        if (sessionBrowser.isConnected()) {
          await sessionBrowser.close().catch(() => null);
        }
      } else if (sessionBrowser) {
        await sessionBrowser.close().catch(() => null);
      }
    }, VERIFICATION_TIMEOUT_MS);

    pendingVerificationSessions.set(accountId, {
      accountId,
      email: account.email,
      browser: page.browser(),
      page,
      account,
      ip,
      resumeBumping:
        typeof options?.onVerified === "function" ? options.onVerified : null,
      onTimeout:
        typeof options?.onTimeout === "function" ? options.onTimeout : null,
      onFailure:
        typeof options?.onFailure === "function" ? options.onFailure : null,
      expiryTimer
    });

    console.log("[VERIFICATION] Waiting for verification code from dashboard");
    return "AWAITING_USER_CODE";
  } catch (error) {
    await Account.findByIdAndUpdate(accountId, {
      status: "login_failed",
      lastError: error.message
    }).catch(() => null);
    await updateStatus(accountId, "login_failed", {
      ip,
      email: account.email
    }).catch(() => null);

    if (typeof options?.onFailure === "function") {
      await options.onFailure("Could not initialize verification flow");
    }

    return false;
  }
}

startRecoveryLoop();

module.exports = {
  // Worker manager API
  requestStart,
  requestStop,
  restartAccount,
  startAll,
  stopAll,
  resetRetry,
  getWorkerStatus,
  isRunning,
  start: requestStart,
  stop: requestStop,

  // Low-level worker controls (kept for compatibility)
  startWorker,
  stopWorker,

  // Existing helpers
  runAccount,
  testProxyNavigation,
  submitVerificationCode,
  handleDeviceVerification,
  clearPendingVerificationSession
};

