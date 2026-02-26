const mongoose = require("mongoose");
const User = require("../model/User");
const {
  getOrCreateAppSettings,
  isValidTelegramChatId,
  isValidTelegramToken
} = require("../utils/telegram");

const TELEGRAM_CHAT_ID_REGEX = /^-?\d+$/;

function normalizeString(value) {
  return String(value || "").trim();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") return value;
  const normalized = normalizeString(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCsvSet(value, transform = (item) => item) {
  const result = new Set();
  const raw = normalizeString(value);
  if (!raw) return result;

  raw
    .split(",")
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .forEach((item) => {
      const next = transform(item);
      if (next) {
        result.add(next);
      }
    });

  return result;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveDefaultUser(defaultUserRaw) {
  const normalized = normalizeString(defaultUserRaw);
  if (!normalized) {
    return null;
  }

  if (mongoose.Types.ObjectId.isValid(normalized)) {
    const byId = await User.findById(normalized)
      .select("_id username email isActive")
      .lean();
    if (byId) return byId;
  }

  const usernameRegex = new RegExp(`^${escapeRegex(normalized)}$`, "i");
  const emailLower = normalized.toLowerCase();

  return User.findOne({
    $or: [{ username: usernameRegex }, { email: emailLower }]
  })
    .select("_id username email isActive")
    .lean();
}

function getEnvTelegramControlConfig() {
  const token = normalizeString(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = normalizeString(process.env.TELEGRAM_CHAT_ID);
  const enabled = parseBoolean(process.env.TELEGRAM_ENABLED, true);
  const defaultUser = normalizeString(process.env.TELEGRAM_DEFAULT_USER);

  const adminUsernames = parseCsvSet(
    process.env.TELEGRAM_ADMIN_USERNAMES,
    (item) => item.toLowerCase()
  );

  const adminIds = parseCsvSet(process.env.TELEGRAM_ADMIN_IDS, (item) => {
    return /^\d+$/.test(item) ? item : "";
  });

  return {
    token,
    chatId,
    enabled,
    defaultUser,
    adminUsernames,
    adminIds
  };
}

function sanitizeChatId(value) {
  const chatId = normalizeString(value);
  if (!chatId) return "";
  if (!TELEGRAM_CHAT_ID_REGEX.test(chatId)) return "";
  return chatId;
}

async function getTelegramControlConfig() {
  const env = getEnvTelegramControlConfig();
  const defaultUserDoc = await resolveDefaultUser(env.defaultUser);

  let settingsDoc = null;
  if (defaultUserDoc?._id) {
    settingsDoc = await getOrCreateAppSettings(defaultUserDoc._id);
  }

  const persistedChatId = sanitizeChatId(settingsDoc?.telegramChatId);
  const effectiveChatId = persistedChatId || sanitizeChatId(env.chatId);
  const desiredEnabled =
    settingsDoc && typeof settingsDoc.telegramEnabled === "boolean"
      ? settingsDoc.telegramEnabled
      : env.enabled;

  const hasTokenConfigured = isValidTelegramToken(env.token);
  const chatIdValid = isValidTelegramChatId(effectiveChatId);

  return {
    token: env.token,
    chatId: effectiveChatId,
    enabled: Boolean(desiredEnabled && hasTokenConfigured && chatIdValid),
    desiredEnabled: Boolean(desiredEnabled),
    hasTokenConfigured,
    defaultUser: defaultUserDoc
      ? {
          _id: String(defaultUserDoc._id),
          username: defaultUserDoc.username,
          email: defaultUserDoc.email,
          isActive: defaultUserDoc.isActive !== false
        }
      : null,
    adminUsernames: env.adminUsernames,
    adminIds: env.adminIds,
    settingsDoc
  };
}

async function updateTelegramControlSettings(payload = {}) {
  const config = await getTelegramControlConfig();
  if (!config.defaultUser?._id) {
    throw new Error("TELEGRAM_DEFAULT_USER could not be resolved to an existing user");
  }

  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, "enabled");
  const hasChatId = Object.prototype.hasOwnProperty.call(payload, "chatId");

  const requestedEnabled = hasEnabled
    ? parseBoolean(payload.enabled, config.desiredEnabled)
    : config.desiredEnabled;

  let requestedChatId = hasChatId
    ? sanitizeChatId(payload.chatId)
    : sanitizeChatId(config.chatId);

  if (requestedChatId && !isValidTelegramChatId(requestedChatId)) {
    throw new Error("Invalid Telegram chat ID format");
  }

  if (requestedEnabled && !requestedChatId) {
    throw new Error("chatId is required when Telegram is enabled");
  }

  if (!requestedChatId) {
    requestedChatId = "";
  }

  if (requestedEnabled && !config.hasTokenConfigured) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured in environment");
  }

  const settings = config.settingsDoc || (await getOrCreateAppSettings(config.defaultUser._id));
  settings.telegramEnabled = Boolean(requestedEnabled);
  settings.telegramChatId = requestedChatId;
  await settings.save();

  return getTelegramControlConfig();
}

function buildTelegramAdminPayload(config) {
  return {
    enabled: Boolean(config?.enabled),
    chatId: String(config?.chatId || ""),
    hasTokenConfigured: Boolean(config?.hasTokenConfigured)
  };
}

module.exports = {
  getEnvTelegramControlConfig,
  getTelegramControlConfig,
  updateTelegramControlSettings,
  buildTelegramAdminPayload,
  parseBoolean,
  sanitizeChatId
};

