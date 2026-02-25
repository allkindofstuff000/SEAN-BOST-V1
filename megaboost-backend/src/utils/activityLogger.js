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

async function emitLogEvents(log, io = global.io) {
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
    await emitToUserEvent(userId, "new-log", log).catch(() => null);
    await emitToUserEvent(userId, "log:new", log).catch(() => null);
  }

  try {
    const stats = await buildStatsSnapshot(userId);
    if (io) {
      emitToUser(io, userId, "stats-update", stats);
    } else {
      await emitToUserEvent(userId, "stats-update", stats).catch(() => null);
    }
  } catch (error) {
    console.error("[LOG] Failed to emit stats update:", error.message);
  }
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

  const normalizedMessage = message.toLowerCase();
  if (
    normalizedMessage === "worker heartbeat" ||
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

  if (options.telegram !== false) {
    await sendTelegramFromLog(plainLog).catch(() => null);
  }

  if (options.emit !== false) {
    await emitLogEvents(plainLog, options.io);
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
