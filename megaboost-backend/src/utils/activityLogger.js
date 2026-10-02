const Log = require("../model/Log");
const Account = require("../model/Account");
const mongoose = require("mongoose");
const { sendTelegramFromLog } = require("./telegram");
const { emitToUser, normalizeUserId } = require("./socketEvents");
const { emitToUserEvent } = require("../internal/eventBridge");

const LEVELS = new Set(["success", "warning", "error", "info"]);
const DEFAULT_LEVEL = "info";

function normalizeLevel(level) {
  const value = String(level || DEFAULT_LEVEL).trim().toLowerCase();
  return LEVELS.has(value) ? value : DEFAULT_LEVEL;
}

function normalizeIp(ip) {
  const value = String(ip || "").trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("::ffff:")) {
    return value.slice(7);
  }

  return value;
}

function extractForwardedIp(forwarded) {
  if (Array.isArray(forwarded)) {
    return normalizeIp(forwarded[0]);
  }

  const value = String(forwarded || "").trim();
  if (!value) {
    return "";
  }

  return normalizeIp(value.split(",")[0]);
}

function getClientIp(req) {
  if (!req) {
    return "";
  }

  return (
    extractForwardedIp(req.headers?.["x-forwarded-for"]) ||
    normalizeIp(req.ip) ||
    normalizeIp(req.socket?.remoteAddress) ||
    normalizeIp(req.connection?.remoteAddress)
  );
}

function normalizeStats(rows) {
  const stats = {
    total: 0,
    success: 0,
    warning: 0,
    error: 0,
    info: 0
  };

  for (const row of rows) {
    const level = row?._id;
    const count = Number(row?.count || 0);

    if (Object.prototype.hasOwnProperty.call(stats, level)) {
      stats[level] = count;
    }

    stats.total += count;
  }

  return stats;
}

async function buildStatsSnapshot(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const pipeline = [];

  if (normalizedUserId) {
    const matchUserId = mongoose.Types.ObjectId.isValid(normalizedUserId)
      ? new mongoose.Types.ObjectId(normalizedUserId)
      : normalizedUserId;
    pipeline.push({
      $match: {
        userId: matchUserId
      }
    });
  }

  pipeline.push({
    $group: {
      _id: "$level",
      count: { $sum: 1 }
    }
  });

  const rows = await Log.aggregate(pipeline);

  return normalizeStats(rows);
}

// Debounce the per-user stats aggregate: a "Start All" burst (or steady worker
// activity) used to run one full Log.aggregate PER log write, on the write path.
// Collapse those into at most one aggregate per user per window.
const STATS_DEBOUNCE_MS = 3000;
const statsTimers = new Map();

function scheduleStatsEmit(userId, io) {
  const uid = normalizeUserId(userId);
  if (!uid || statsTimers.has(uid)) {
    return;
  }

  const timer = setTimeout(() => {
    statsTimers.delete(uid);
    (async () => {
      const stats = await buildStatsSnapshot(uid);
      const activeIo = io || global.io;
      if (activeIo) {
        emitToUser(activeIo, uid, "stats-update", stats);
      } else {
        await emitToUserEvent(uid, "stats-update", stats).catch(() => null);
      }
    })().catch((error) => {
      console.error("[LOG] Failed to emit stats update:", error.message);
    });
  }, STATS_DEBOUNCE_MS);

  if (typeof timer.unref === "function") timer.unref();
  statsTimers.set(uid, timer);
}

function emitLogEvents(log, io = global.io) {
  if (!log) {
    return;
  }

  const userId = normalizeUserId(log.userId);
  if (!userId) {
    return;
  }

  if (io) {
    emitToUser(io, userId, "new-log", log);
    emitToUser(io, userId, "log:new", log);
  } else {
    emitToUserEvent(userId, "new-log", log).catch(() => null);
    emitToUserEvent(userId, "log:new", log).catch(() => null);
  }

  scheduleStatsEmit(userId, io);
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  return metadata;
}

async function resolveLogUserId(payload, options = {}) {
  const fromPayload = normalizeUserId(payload?.userId);
  if (fromPayload) {
    return fromPayload;
  }

  const fromOptions = normalizeUserId(options?.userId);
  if (fromOptions) {
    return fromOptions;
  }

  const accountId = String(payload?.accountId || "").trim();
  if (!accountId) {
    return "";
  }

  const account = await Account.findById(accountId).select("userId").lean().catch(() => null);
  return normalizeUserId(account?.userId);
}

async function createActivityLog(payload, options = {}) {
  const message = String(payload?.message || "").trim();
  if (!message) {
    throw new Error("Activity log message is required");
  }

  // Do NOT persist heartbeat keepalives. The worker emits them as
  // "Heartbeat <status>/<step>: <email>" (plus a live socket event), so the
  // previous exact-string filter missed them and they were flooding the logs
  // collection (144+ rows/day/account) — the main driver of log bloat + the
  // per-write aggregate lag.
  const normalizedMessage = message.toLowerCase();
  if (
    payload?.metadata?.heartbeat === true ||
    normalizedMessage === "worker heartbeat" ||
    normalizedMessage.startsWith("heartbeat ") ||
    normalizedMessage.includes("[heartbeat]") ||
    normalizedMessage.includes("worker:heartbeat")
  ) {
    return null;
  }

  const logPayload = {
    level: normalizeLevel(payload.level),
    message
  };

  const userId = await resolveLogUserId(payload, options);
  if (!userId) {
    throw new Error("Activity log userId is required");
  }
  logPayload.userId = userId;

  const email = String(payload?.email || "").trim();
  if (email) {
    logPayload.email = email;
  }

  const ip = normalizeIp(payload?.ip);
  if (ip) {
    logPayload.ip = ip;
  }

  if (payload?.accountId) {
    logPayload.accountId = payload.accountId;
  }

  const metadata = normalizeMetadata(payload?.metadata);
  if (metadata) {
    logPayload.metadata = metadata;
  }

  const created = await Log.create(logPayload);
  const plainLog = created?.toObject ? created.toObject() : created;

  // Fire-and-forget: keep the (awaited) worker path off the Telegram network
  // call and the stats aggregate. Both have their own error handling.
  if (options.telegram !== false) {
    sendTelegramFromLog(plainLog).catch(() => null);
  }

  if (options.emit !== false) {
    try {
      emitLogEvents(plainLog, options.io);
    } catch (error) {
      console.error("[LOG] Failed to emit log events:", error.message);
    }
  }

  return plainLog;
}

async function logActivity(payload, options = {}) {
  try {
    return await createActivityLog(payload, options);
  } catch (error) {
    console.error("[LOG] Failed to create activity log:", error.message);
    return null;
  }
}

module.exports = {
  createActivityLog,
  logActivity,
  getClientIp,
  normalizeLevel
};
