const express = require("express");
const {
  buildTelegramPublicConfig,
  getOrCreateAppSettings,
  isValidTelegramChatId,
  isValidTelegramToken,
  sendTelegramMessage
} = require("../utils/telegram");

const router = express.Router();

function hasOwn(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload || {}, key);
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

router.get("/telegram", async (req, res) => {
  try {
    const settings = await getOrCreateAppSettings(req.user?._id);
    return res.status(200).json(buildTelegramPublicConfig(settings));
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to load Telegram settings"
    });
  }
});

router.put("/telegram", async (req, res) => {
  try {
    const settings = await getOrCreateAppSettings(req.user?._id);

    const body = req.body || {};
    const hasEnabled = hasOwn(body, "enabled");
    const hasBotToken = hasOwn(body, "botToken");
    const hasChatId = hasOwn(body, "chatId");

    const nextToken = hasBotToken
      ? String(body.botToken || "").trim()
      : String(settings.telegramBotToken || "").trim();
    const nextChatId = hasChatId
      ? String(body.chatId || "").trim()
      : String(settings.telegramChatId || "").trim();
    const nextEnabled = hasEnabled
      ? normalizeBoolean(body.enabled, false)
      : (hasBotToken || hasChatId)
        ? true
        : Boolean(settings.telegramEnabled);

    if (nextToken && !isValidTelegramToken(nextToken)) {
      return res.status(400).json({
        message: "Invalid Telegram bot token format"
      });
    }

    if (nextChatId && !isValidTelegramChatId(nextChatId)) {
      return res.status(400).json({
        message: "Invalid Telegram chat ID format"
      });
    }

    if (nextEnabled && (!nextToken || !nextChatId)) {
      return res.status(400).json({
        message: "botToken and chatId are required when Telegram is enabled"
      });
    }

    settings.telegramEnabled = Boolean(nextEnabled && nextToken && nextChatId);
    settings.telegramBotToken = nextToken;
    settings.telegramChatId = nextChatId;
    await settings.save();

    return res.status(200).json(buildTelegramPublicConfig(settings));
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to save Telegram settings"
    });
  }
});

router.post("/telegram/test", async (req, res) => {
  try {
    const settings = await getOrCreateAppSettings(req.user?._id);
    const token = String(settings.telegramBotToken || "").trim();
    const chatId = String(settings.telegramChatId || "").trim();

    if (!token || !chatId) {
      return res.status(400).json({
        ok: false,
        message: "Telegram is not configured"
      });
    }

    if (!isValidTelegramToken(token) || !isValidTelegramChatId(chatId)) {
      return res.status(400).json({
        ok: false,
        message: "Telegram settings are invalid"
      });
    }

    const result = await sendTelegramMessage("✅ Telegram connected", {
      force: true,
      settingsDoc: settings,
      throttleKey: "telegram:test",
      skipThrottle: true,
      userId: req.user?._id
    });

    if (!result?.ok) {
      return res.status(502).json({
        ok: false,
        message: "Failed to send test message"
      });
    }

    return res.status(200).json({
      ok: true
    });
  } catch {
    return res.status(500).json({
      ok: false,
      message: "Failed to send test message"
    });
  }
});

module.exports = router;
