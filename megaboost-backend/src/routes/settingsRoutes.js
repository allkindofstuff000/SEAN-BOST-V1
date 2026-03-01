const express = require("express");
const { isValidTelegramChatId, isValidTelegramToken } = require("../utils/telegram");
const {
  getOrCreateTelegramSettings,
  buildSettingsPublicPayload,
  reloadTelegramBotFromSettings,
  refreshTelegramPanel
} = require("../integrations/telegram/telegramBot");

const router = express.Router();

function hasOwn(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload || {}, key);
}

router.get("/telegram", async (_req, res) => {
  try {
    const settings = await getOrCreateTelegramSettings();
    return res.status(200).json(buildSettingsPublicPayload(settings));
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to load Telegram settings"
    });
  }
});

async function saveTelegramSettings(req, res) {
  try {
    const settings = await getOrCreateTelegramSettings();
    const body = req.body || {};

    const hasBotToken = hasOwn(body, "botToken");
    const hasChatId = hasOwn(body, "chatId");

    const nextToken = hasBotToken ? String(body.botToken || "").trim() : String(settings.botToken || "").trim();
    const nextChatId = hasChatId ? String(body.chatId || "").trim() : String(settings.chatId || "").trim();

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

    const previousChatId = String(settings.chatId || "").trim();

    settings.botToken = nextToken;
    settings.chatId = nextChatId;

    if (!nextToken || !nextChatId || previousChatId !== nextChatId) {
      settings.panelMessageId = null;
    }

    await settings.save();
    await reloadTelegramBotFromSettings();

    return res.status(200).json(buildSettingsPublicPayload(settings));
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to save Telegram settings"
    });
  }
}

router.post("/telegram", saveTelegramSettings);
router.put("/telegram", saveTelegramSettings);

router.post("/telegram/panel", async (_req, res) => {
  try {
    const result = await refreshTelegramPanel();

    if (!result?.ok) {
      return res.status(400).json({
        ok: false,
        message: "Telegram bot is not configured",
        ...result
      });
    }

    return res.status(200).json({
      ok: true,
      messageId: result.messageId || null,
      settings: result.settings || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to refresh Telegram panel"
    });
  }
});

module.exports = router;
