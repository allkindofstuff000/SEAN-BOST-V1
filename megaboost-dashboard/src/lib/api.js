const DEFAULT_TIMEOUT_MS = 15000;
const isProductionBuild = Boolean(import.meta.env.PROD);

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function resolveApiBaseUrl() {
  return normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);
}

export function getSocketBaseUrl() {
  if (isProductionBuild) {
    return "";
  }

  const explicitSocketUrl = normalizeBaseUrl(import.meta.env.VITE_SOCKET_URL);
  if (explicitSocketUrl) {
    return explicitSocketUrl;
  }

  const apiBase = resolveApiBaseUrl();
  if (apiBase) {
    return apiBase;
  }

  return "";
}

const API_BASE = resolveApiBaseUrl();

function resolveRequestUrl(path) {
  const rawPath = String(path || "").trim();
  const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  if (!API_BASE) return normalizedPath;

  // Avoid duplicating "/api" when callers already pass paths like "/api/auth/login".
  if (API_BASE.toLowerCase().endsWith("/api") && /^\/api(?:\/|$)/i.test(normalizedPath)) {
    return `${API_BASE}${normalizedPath.slice(4)}`;
  }

  return `${API_BASE}${normalizedPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitter(maxJitterMs) {
  if (!maxJitterMs || maxJitterMs <= 0) return 0;
  return Math.floor(Math.random() * maxJitterMs);
}

function parseMaybeJson(rawText) {
  if (!rawText) return null;

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function shouldSimulateFailure() {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  if (!window.__SIMULATE_FAIL__) return false;
  return Math.random() < 0.35;
}

async function maybeSimulateDelay() {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;

  const delay = Number(window.__SIMULATE_DELAY_MS__ || 0);
  if (!Number.isFinite(delay) || delay <= 0) return;

  await sleep(delay);
}

function getMessageFromPayload(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  if (payload.message) return payload.message;
  return fallback;
}

function toQueryString(params = {}) {
  const entries = Object.entries(params).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    return true;
  });
  if (entries.length === 0) return "";

  const search = new URLSearchParams();
  entries.forEach(([key, value]) => {
    search.set(key, String(value));
  });
  return `?${search.toString()}`;
}

function createApiError({ message, status, payload, type, retryable, originalError }) {
  const error = new Error(message);
  error.name = "ApiError";
  error.status = status;
  error.type = type;
  error.retryable = Boolean(retryable);
  error.response = { data: payload };
  error.originalError = originalError;
  return error;
}

function classifyResponseError(response, payload) {
  const status = response.status;
  const message = getMessageFromPayload(payload, `Request failed with status ${status}`);
  const retryable = status >= 500 || status === 408 || status === 429;

  return createApiError({
    message,
    status,
    payload,
    type: status >= 500 ? "server" : "client",
    retryable
  });
}

function classifyNetworkError(error) {
  if (error?.name === "AbortError") {
    return createApiError({
      message: "Request timed out",
      status: 0,
      payload: null,
      type: "timeout",
      retryable: true,
      originalError: error
    });
  }

  return createApiError({
    message: error?.message || "Network request failed",
    status: 0,
    payload: null,
    type: "network",
    retryable: true,
    originalError: error
  });
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.retryable) return true;
  if (error.type === "network" || error.type === "timeout") return true;
  if (typeof error.status === "number" && error.status >= 500) return true;
  return false;
}

export async function request(path, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retry,
    ...fetchOptions
  } = options;

  const attempts = Math.max(1, retry?.attempts || 1);
  const delays = Array.isArray(retry?.delays) && retry.delays.length > 0
    ? retry.delays
    : [500, 1500, 4000];
  const jitterMs = retry?.jitterMs ?? 250;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (shouldSimulateFailure()) {
        throw createApiError({
          message: "Simulated failure (window.__SIMULATE_FAIL__)",
          status: 503,
          payload: { message: "Simulated failure" },
          type: "server",
          retryable: true
        });
      }

      await maybeSimulateDelay();

      const response = await fetch(resolveRequestUrl(path), {
        headers: {
          "Content-Type": "application/json",
          ...(fetchOptions.headers || {})
        },
        credentials: "include",
        ...fetchOptions,
        signal: controller.signal
      });

      const rawText = await response.text();
      const payload = parseMaybeJson(rawText);

      if (!response.ok) {
        throw classifyResponseError(response, payload);
      }

      return { data: payload };
    } catch (error) {
      const normalized = error?.name === "ApiError" ? error : classifyNetworkError(error);
      lastError = normalized;

      const retryAllowed = retry?.enabled && attempt < attempts && isRetryableError(normalized);

      if (!retryAllowed) {
        throw normalized;
      }

      const backoff = delays[Math.min(attempt - 1, delays.length - 1)] + randomJitter(jitterMs);
      await sleep(backoff);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Request failed");
}

const api = {
  get(path, options = {}) {
    return request(path, { method: "GET", ...options });
  },
  post(path, body, options = {}) {
    return request(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      ...options
    });
  },
  put(path, body, options = {}) {
    return request(path, {
      method: "PUT",
      body: JSON.stringify(body ?? {}),
      ...options
    });
  },
  delete(path, options = {}) {
    return request(path, { method: "DELETE", ...options });
  }
};

export async function getLicenseLimits(options = {}) {
  const res = await api.get("/api/license/me", options);
  return res.data?.data || res.data;
}

export async function login(payload, options = {}) {
  const res = await api.post("/api/auth/login", payload, options);
  return res.data;
}

export async function logout(options = {}) {
  const res = await api.post("/api/auth/logout", {}, options);
  return res.data;
}

export async function getMe(options = {}) {
  const res = await api.get("/api/auth/me", options);
  return res.data?.data || null;
}

export async function getMyLicense(options = {}) {
  const res = await api.get("/api/license/me", options);
  return res.data?.data || res.data;
}

export async function createAccount(payload, options = {}) {
  const res = await api.post("/api/accounts", payload, options);
  return res.data;
}

export async function getAccountById(id, options = {}) {
  const res = await api.get(`/api/accounts/${id}`, options);
  return res.data?.data || res.data;
}

export async function updateAccount(id, payload, options = {}) {
  const res = await api.put(`/api/accounts/${id}`, payload, options);
  return res.data?.data || res.data;
}

export async function getAccountActivity(id, options = {}) {
  const res = await api.get(`/api/accounts/${id}/activity`, options);
  return res.data?.data || res.data;
}

export async function getAccountBumps(id, options = {}) {
  const res = await api.get(`/api/accounts/${id}/bumps`, options);
  return res.data?.data || res.data;
}

export async function getBumpPresets(options = {}) {
  const res = await api.get("/api/bump/presets", options);
  return res.data?.data || [];
}

export async function applyBumpPreset(
  preset,
  applyTo = "all",
  options = {}
) {
  const res = await api.post(
    "/api/bump/presets/apply",
    { preset, applyTo },
    options
  );
  return res.data;
}

export async function getTelegramSettings(options = {}) {
  const res = await api.get("/api/settings/telegram", options);
  return res.data;
}

export async function updateTelegramSettings(payload, options = {}) {
  const res = await api.put("/api/settings/telegram", payload, options);
  return res.data;
}

export async function testTelegramSettings(options = {}) {
  const res = await api.post("/api/settings/telegram/test", {}, options);
  return res.data;
}

export async function adminGetOverview(options = {}) {
  const res = await api.get("/api/admin/overview", options);
  return res.data?.data || res.data;
}

export async function adminCreateLicense(payload, options = {}) {
  const res = await api.post("/api/admin/licenses", payload, options);
  return res.data?.data || res.data;
}

export async function adminListLicenses(params = {}, options = {}) {
  const query = toQueryString(params);
  const res = await api.get(`/api/admin/licenses${query}`, options);
  return res.data;
}

export async function adminUpdateLicense(id, payload, options = {}) {
  const res = await api.put(`/api/admin/licenses/${id}`, payload, options);
  return res.data?.data || res.data;
}

export async function adminCreateUser(payload, options = {}) {
  const res = await api.post("/api/admin/users", payload, options);
  return res.data?.data || res.data;
}

export async function adminListUsers(params = {}, options = {}) {
  const query = toQueryString(params);
  const res = await api.get(`/api/admin/users${query}`, options);
  return res.data;
}

export async function adminUpdateUser(id, payload, options = {}) {
  const res = await api.put(`/api/admin/users/${id}`, payload, options);
  return res.data?.data || res.data;
}

export { isRetryableError };
export default api;
