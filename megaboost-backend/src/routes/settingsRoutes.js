const express = require("express");
const { isValidTelegramChatId, isValidTelegramToken } = require("../utils/telegram");
const {
  getOrCreateTelegramSettings,
  buildSettingsPublicPayload
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
    const nextUserId = String(req.user?._id || "").trim();

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
    const previousUserId = String(settings.userId || "").trim();

    settings.botToken = nextToken;
    settings.chatId = nextChatId;

    if (nextUserId) {
      settings.userId = nextUserId;
    }

    if (
      !nextToken ||
      !nextChatId ||
      previousChatId !== nextChatId ||
      (nextUserId && previousUserId !== nextUserId)
    ) {
      settings.panelMessageId = null;
    }

    await settings.save();

    // Dedicated PM2 telegram process reloads settings on interval.
    return res.status(200).json(buildSettingsPublicPayload(settings));
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to save Telegram settings"
    });
  }
}

router.post("/telegram", saveTelegramSettings);
router.put("/telegram", saveTelegramSettings);

async function handlePanelRefreshLike(_req, res) {
  try {
    const settings = await getOrCreateTelegramSettings();
    const payload = buildSettingsPublicPayload(settings);

    if (!payload.enabled) {
      return res.status(400).json({
        ok: false,
        message: "Telegram bot is not configured",
        settings: payload
      });
    }

    if (!payload.userId) {
      return res.status(400).json({
        ok: false,
        message: "Telegram user scope is missing. Save Telegram settings again from your dashboard.",
        settings: payload
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Settings verified. Use /panel in your configured Telegram group to refresh the panel.",
      settings: payload
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message || "Failed to verify Telegram settings"
    });
  }
}

router.post("/telegram/panel", handlePanelRefreshLike);

// Backward compatibility for dashboard clients using legacy Send Test endpoint.
router.post("/telegram/test", handlePanelRefreshLike);

module.exports = router;
