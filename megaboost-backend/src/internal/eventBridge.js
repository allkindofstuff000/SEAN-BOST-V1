const Account = require("../model/Account");
const {
  emitAccountUpdate: emitSocketAccountUpdate,
  emitToUser: emitSocketToUser,
  normalizeUserId
} = require("../utils/socketEvents");

const INTERNAL_EVENT_URL = String(
  process.env.INTERNAL_EVENTS_URL ||
    process.env.WORKER_EVENT_TARGET_URL ||
    "http://127.0.0.1:5000/api/internal/events"
).trim();
const INTERNAL_EVENT_SECRET = String(process.env.INTERNAL_EVENT_SECRET || "").trim();
const INTERNAL_EVENT_TIMEOUT_MS = Number(process.env.INTERNAL_EVENT_TIMEOUT_MS || 5000);
const INTERNAL_EVENT_WARN_INTERVAL_MS = Number(
  process.env.INTERNAL_EVENT_WARN_INTERVAL_MS || 60 * 1000
);

let lastInternalWarningAt = 0;

function maybeWarn(message) {
  const now = Date.now();
  if (now - lastInternalWarningAt < INTERNAL_EVENT_WARN_INTERVAL_MS) {
    return;
  }

  lastInternalWarningAt = now;
  console.warn(message);
}

function normalizeAccountId(accountOrId) {
  if (!accountOrId) return "";
  if (typeof accountOrId === "string") return accountOrId.trim();
  return String(accountOrId._id || accountOrId.id || "").trim();
}

function hasLocalSocketServer() {
  return Boolean(global.io && typeof global.io.to === "function");
}

async function postInternalEvent(payload) {
  if (!INTERNAL_EVENT_URL || !INTERNAL_EVENT_SECRET) {
    maybeWarn("[INTERNAL EVENT] Missing INTERNAL_EVENTS_URL or INTERNAL_EVENT_SECRET");
    return false;
  }

  if (typeof fetch !== "function") {
    maybeWarn("[INTERNAL EVENT] fetch is not available in this Node runtime");
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERNAL_EVENT_TIMEOUT_MS);

  try {
    const response = await fetch(INTERNAL_EVENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-event-secret": INTERNAL_EVENT_SECRET
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      maybeWarn(`[INTERNAL EVENT] ${response.status} ${response.statusText} ${raw}`.trim());
      return false;
    }

    return true;
  } catch (error) {
    maybeWarn(`[INTERNAL EVENT] Request failed: ${error.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveUserId(accountOrId, explicitUserId = "") {
  const normalizedExplicit = normalizeUserId(explicitUserId);
  if (normalizedExplicit) return normalizedExplicit;

  if (accountOrId && typeof accountOrId === "object") {
    const embedded = normalizeUserId(accountOrId.userId);
    if (embedded) return embedded;
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return "";

  const account = await Account.findById(accountId).select("userId").lean().catch(() => null);
  return normalizeUserId(account?.userId);
}

async function emitToUserEvent(userId, eventName, payload = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedEventName = String(eventName || "").trim();
  if (!normalizedUserId || !normalizedEventName) {
    return false;
  }

  if (hasLocalSocketServer()) {
    return emitSocketToUser(global.io, normalizedUserId, normalizedEventName, payload);
  }

  return postInternalEvent({
    userId: normalizedUserId,
    eventName: normalizedEventName,
    payload
  });
}

async function emitAccountUpdateEvent(accountOrId, patch = {}, extra = {}, userId = "") {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return false;

  const resolvedUserId = await resolveUserId(accountOrId, userId);
  if (!resolvedUserId) return false;

  if (hasLocalSocketServer()) {
    return emitSocketAccountUpdate(
      global.io,
      {
        _id: accountId,
        userId: resolvedUserId
      },
      patch,
      extra
    );
  }

  return postInternalEvent({
    userId: resolvedUserId,
    eventName: "account:update",
    payload: {
      accountId,
      patch: {
        ...patch
      },
      ...extra
    }
  });
}

module.exports = {
  emitAccountUpdateEvent,
  emitToUserEvent,
  postInternalEvent
};
