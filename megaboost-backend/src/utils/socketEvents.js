const Account = require("../model/Account");

function normalizeUserId(userId) {
  if (!userId) return "";
  return String(userId).trim();
}

function getUserRoom(userId) {
  const normalized = normalizeUserId(userId);
  if (!normalized) return "";
  return `user:${normalized}`;
}

function withUserId(payload, userId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "userId")) {
    return payload;
  }

  return {
    ...payload,
    userId
  };
}

function emitToUser(io, userId, eventName, payload = {}) {
  const room = getUserRoom(userId);
  if (!io || !room || !eventName) {
    return false;
  }

  io.to(room).emit(eventName, withUserId(payload, normalizeUserId(userId)));
  return true;
}

function normalizeAccountId(accountOrId) {
  if (!accountOrId) return "";
  if (typeof accountOrId === "string") return accountOrId.trim();
  return String(accountOrId._id || accountOrId.id || "").trim();
}

function extractUserIdFromAccount(accountOrId) {
  if (!accountOrId || typeof accountOrId !== "object") return "";
  return normalizeUserId(accountOrId.userId);
}

async function resolveAccountUserId(accountOrId) {
  const embeddedUserId = extractUserIdFromAccount(accountOrId);
  if (embeddedUserId) {
    return embeddedUserId;
  }

  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return "";

  const account = await Account.findById(accountId).select("userId").lean().catch(() => null);
  return normalizeUserId(account?.userId);
}

async function emitToAccount(io, accountOrId, eventName, payload = {}) {
  const userId = await resolveAccountUserId(accountOrId);
  if (!userId) {
    return false;
  }

  return emitToUser(io, userId, eventName, payload);
}

async function emitAccountUpdate(io, accountOrId, patch = {}, extra = {}) {
  const accountId = normalizeAccountId(accountOrId);
  if (!accountId) return false;

  return emitToAccount(io, accountOrId, "account:update", {
    accountId: String(accountId),
    patch: {
      ...patch
    },
    ...extra
  });
}

module.exports = {
  emitAccountUpdate,
  emitToAccount,
  emitToUser,
  getUserRoom,
  normalizeUserId
};
