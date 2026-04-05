const express = require("express");
const geoip = require("geoip-lite");
const AppSettings = require("../model/AppSettings");
const Account = require("../model/Account");
const User = require("../model/User");
const { isValidTelegramChatId, isValidTelegramToken } = require("../utils/telegram");
const { TelegramSettings } = require("../model/TelegramSettings");
const { getOrCreateAppSettings, sanitizeAppTimingPatch, buildAppSettingsPublicPayload } = require("../utils/appSettings");
const {
  getOrCreateTelegramSettings,
  buildSettingsPublicPayload
} = require("../integrations/telegram/telegramBot");

const router = express.Router();

function hasOwn(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload || {}, key);
}

function getRequestUserId(req) {
  return String(req.user?._id || "").trim();
}

async function patchTelegramSettingsByUserId(userIdInput, patch = {}) {
  const userId = String(userIdInput || "").trim();
  if (!userId) {
    throw new Error("Authentication required");
  }

  const safePatch = patch && typeof patch === "object" ? patch : {};
  return TelegramSettings.findOneAndUpdate(
    { userId },
    {
      $set: {
        userId,
        ...safePatch
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    }
  );
}

router.get("/language", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const user = await User.findById(userId).select("language").lean();
    return res.status(200).json({ language: user?.language || "en" });
  } catch {
    return res.status(200).json({ language: "en" });
  }
});

router.post("/language", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const lang = req.body?.language === "es" ? "es" : "en";
    await User.findByIdAndUpdate(userId, { $set: { language: lang } });
    return res.status(200).json({ saved: true, language: lang });
  } catch (error) {
    return res.status(500).json({ message: error?.message || "Failed to save language" });
  }
});

router.get("/detect-timezone", async (req, res) => {
  try {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const realIp = String(req.headers["x-real-ip"] || "").trim();
    const cfIp = String(req.headers["cf-connecting-ip"] || "").trim();
    const socketIp = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    const clientIp = forwarded || realIp || cfIp || socketIp || "";

    const privatePatterns = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|localhost|0\.0\.0\.0)/;
    if (!clientIp || privatePatterns.test(clientIp)) {
      return res.status(200).json({
        detected: false,
        timezone: "UTC",
        label: "UTC",
        city: "",
        ip: clientIp
      });
    }

    const geo = geoip.lookup(clientIp);
    if (geo && geo.timezone) {
      const tz = geo.timezone;
      const city = String(geo.city || "").trim();
      const country = String(geo.country || "").trim();
      const label = city ? `${city}${country ? `, ${country}` : ""}` : tz;

      return res.status(200).json({
        detected: true,
        timezone: tz,
        label,
        city,
        country,
        ip: clientIp
      });
    }

    return res.status(200).json({
      detected: false,
      timezone: "UTC",
      label: "UTC",
      city: "",
      ip: clientIp
    });
  } catch (error) {
    return res.status(200).json({
      detected: false,
      timezone: "UTC",
      label: "UTC",
      city: "",
      ip: ""
    });
  }
});

router.get("/telegram", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required"
      });
    }

    const settings = await getOrCreateTelegramSettings(userId);
    return res.status(200).json(buildSettingsPublicPayload(settings));
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to load Telegram settings"
    });
  }
});

router.get("/app", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required"
      });
    }

    const settings = await getOrCreateAppSettings(userId);
    return res.status(200).json(buildAppSettingsPublicPayload(settings));
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to load app settings"
    });
  }
});

async function saveAppSettings(req, res) {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required"
      });
    }

    const existing = await getOrCreateAppSettings(userId);
    const patch = sanitizeAppTimingPatch({
      timezone: hasOwn(req.body, "timezone") ? req.body.timezone : existing.timezone,
      timezoneLabel: hasOwn(req.body, "timezoneLabel")
        ? req.body.timezoneLabel
        : existing.timezoneLabel,
      uiTimeFormat: hasOwn(req.body, "uiTimeFormat")
        ? req.body.uiTimeFormat
        : existing.uiTimeFormat
    });

    const timezoneChanged = patch.timezone && patch.timezone !== existing.timezone;

    const updated = await AppSettings.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          ...patch
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    let accountsUpdated = 0;
    if (timezoneChanged) {
      const result = await Account.updateMany(
        { userId },
        { $set: { timezone: patch.timezone } }
      );
      accountsUpdated = result.modifiedCount || 0;
    }

    const payload = buildAppSettingsPublicPayload(updated || existing);
    payload.accounts_updated = accountsUpdated;
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to save app settings"
    });
  }
}

router.post("/app", saveAppSettings);
router.put("/app", saveAppSettings);

async function saveTelegramSettings(req, res) {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required"
      });
    }

    const settings = await getOrCreateTelegramSettings(userId);
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
    const nextPanelMessageId =
      !nextToken || !nextChatId || previousChatId !== nextChatId
        ? null
        : Number(settings.panelMessageId || 0) || null;

    const updated = await patchTelegramSettingsByUserId(userId, {
      botToken: nextToken,
      chatId: nextChatId,
      panelMessageId: nextPanelMessageId
    });

    // Dedicated PM2 telegram process reloads settings on interval.
    return res.status(200).json(buildSettingsPublicPayload(updated || settings));
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to save Telegram settings"
    });
  }
}

router.post("/telegram", saveTelegramSettings);
router.put("/telegram", saveTelegramSettings);

async function handlePanelRefreshLike(req, res) {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Authentication required"
      });
    }

    const settings = await getOrCreateTelegramSettings(userId);
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
