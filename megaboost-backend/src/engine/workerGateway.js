const PROCESS_ROLE = String(process.env.PROCESS_ROLE || "api").trim().toLowerCase();
const IS_WORKER_PROCESS = PROCESS_ROLE === "worker";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const WORKER_COMMAND_BASE_URL = String(
  process.env.WORKER_COMMAND_URL || "http://127.0.0.1:5001/internal/worker"
).trim();
const INTERNAL_EVENT_SECRET = String(process.env.INTERNAL_EVENT_SECRET || "").trim();
const WORKER_COMMAND_TIMEOUT_MS = Number(process.env.WORKER_COMMAND_TIMEOUT_MS || 15000);

function normalizeAccountId(accountOrId) {
  if (!accountOrId) return "";
  if (typeof accountOrId === "string") return accountOrId.trim();
  return String(accountOrId._id || accountOrId.id || "").trim();
}

function normalizeUserId(userId) {
  if (!userId) return "";
  return String(userId).trim();
}

function shouldUseRemoteWorker() {
  if (IS_WORKER_PROCESS) return false;
  if (String(process.env.WORKER_COMMAND_URL || "").trim()) return true;
  return IS_PRODUCTION && PROCESS_ROLE === "api";
}

const USE_REMOTE_WORKER = shouldUseRemoteWorker();
const localWorkerManager = USE_REMOTE_WORKER ? null : require("./worker");

function buildHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  if (INTERNAL_EVENT_SECRET) {
    headers["x-internal-event-secret"] = INTERNAL_EVENT_SECRET;
  }

  return headers;
}

function assertRemoteWorkerAuthConfigured() {
  if (!INTERNAL_EVENT_SECRET) {
    throw new Error(
      "INTERNAL_EVENT_SECRET is required when using remote worker commands"
    );
  }
}

async function parseResponsePayload(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

async function remoteRequest(pathname, { method = "POST", body, timeoutMs = WORKER_COMMAND_TIMEOUT_MS } = {}) {
  assertRemoteWorkerAuthConfigured();

  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }

  const base = WORKER_COMMAND_BASE_URL.replace(/\/+$/, "");
  const cleanPath = String(pathname || "").replace(/^\/+/, "");
  const endpoint = `${base}/${cleanPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method,
      headers: buildHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const payload = await parseResponsePayload(response);

    if (!response.ok) {
      const message =
        payload?.message ||
        `Worker command failed: ${response.status} ${response.statusText}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    if (payload && Object.prototype.hasOwnProperty.call(payload, "data")) {
      return payload.data;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestStart(accountOrId, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.requestStart(accountOrId, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  const userId = normalizeUserId(options?.userId || accountOrId?.userId);
  return remoteRequest("/request-start", {
    body: { accountId, userId, options }
  });
}

async function requestStop(accountOrId, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.requestStop(accountOrId, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  const userId = normalizeUserId(options?.userId || accountOrId?.userId);
  return remoteRequest("/request-stop", {
    body: { accountId, userId, options }
  });
}

async function restartAccount(accountOrId, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.restartAccount(accountOrId, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  const userId = normalizeUserId(options?.userId || accountOrId?.userId);
  return remoteRequest("/restart", {
    body: { accountId, userId, options }
  });
}

async function stopAll(options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.stopAll(options);
  }

  return remoteRequest("/stop-all", {
    body: { options }
  });
}

async function getWorkerStatus(options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.getWorkerStatus(options);
  }

  const userId = normalizeUserId(options?.userId);
  const path = userId
    ? `/status?userId=${encodeURIComponent(userId)}`
    : "/status";

  return remoteRequest(path, {
    method: "GET",
    timeoutMs: Number(process.env.WORKER_STATUS_TIMEOUT_MS || 5000)
  });
}

async function isRunning(accountOrId, options = {}) {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return false;

  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.isRunning(accountOrId, options);
  }

  const status = await getWorkerStatus(options);
  const runningAccounts = Array.isArray(status?.runningAccounts)
    ? status.runningAccounts.map((value) => String(value))
    : [];
  return runningAccounts.includes(accountId);
}

async function resetRetry(accountOrId, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.resetRetry(accountOrId, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  const userId = normalizeUserId(options?.userId || accountOrId?.userId);
  return remoteRequest("/reset-retry", {
    body: { accountId, userId, options }
  });
}

async function submitVerificationCode(accountOrId, code, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.submitVerificationCode(accountOrId, code, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  return remoteRequest("/submit-verification", {
    body: { accountId, code, options }
  });
}

async function runAccount(accountOrId, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.runAccount(accountOrId, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  const userId = normalizeUserId(options?.userId || accountOrId?.userId);
  return remoteRequest("/run-account", {
    body: { accountId, userId, options }
  });
}

async function testProxyNavigation(accountOrId, options = {}) {
  if (!USE_REMOTE_WORKER) {
    return localWorkerManager.testProxyNavigation(accountOrId, options);
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) throw new Error("accountId is required");
  const userId = normalizeUserId(options?.userId || accountOrId?.userId);
  return remoteRequest("/test-connection", {
    body: { accountId, userId, options }
  });
}

function shouldManageWorkerLifecycle() {
  return !USE_REMOTE_WORKER;
}

module.exports = {
  requestStart,
  requestStop,
  restartAccount,
  stopAll,
  getWorkerStatus,
  isRunning,
  resetRetry,
  submitVerificationCode,
  runAccount,
  testProxyNavigation,
  start: requestStart,
  stop: requestStop,
  shouldManageWorkerLifecycle
};
