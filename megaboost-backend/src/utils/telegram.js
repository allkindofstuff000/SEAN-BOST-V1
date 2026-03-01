const https = require("https");
const AppSettings = require("../model/AppSettings");
const { TelegramSettings, TELEGRAM_SETTINGS_ID } = require("../model/TelegramSettings");

const TELEGRAM_TOKEN_REGEX = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_CHAT_ID_REGEX = /^-?\d+$/;
const DEFAULT_THROTTLE_MS = 2000;
const TELEGRAM_REQUEST_TIMEOUT_MS = 8000;
const lastSentByThrottleKey = new Map();
let legacyAppSettingsIndexChecked = false;

function normalizeString(value) {
  return String(value || "").trim();
}

function maskTelegramToken(token) {
  const raw = normalizeString(token);
  if (!raw) return "";

  if (raw.length <= 10) {
    return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  }

  return `${raw.slice(0, 6)}***${raw.slice(-4)}`;
}

function isValidTelegramToken(token) {
  return TELEGRAM_TOKEN_REGEX.test(normalizeString(token));
}

function isValidTelegramChatId(chatId) {
  return TELEGRAM_CHAT_ID_REGEX.test(normalizeString(chatId));
}

function buildTelegramPublicConfig(settings) {
  const token = normalizeString(settings?.telegramBotToken);
  const chatId = normalizeString(settings?.telegramChatId);
  const enabled = Boolean(settings?.telegramEnabled && token && chatId);

  return {
    enabled,
    chatId,
    tokenMasked: maskTelegramToken(token)
  };
}

async function getOrCreateAppSettings(userIdInput) {
  const userId = normalizeString(userIdInput);
  if (!userId) {
    throw new Error("userId is required to load app settings");
  }

  const runUpsert = () =>
    AppSettings.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        telegramEnabled: false,
        telegramBotToken: "",
        telegramChatId: ""
      }
    },
    {
      upsert: true,
      new: true
    }
  );

  try {
    return await runUpsert();
  } catch (error) {
    const duplicateKeyError = Number(error?.code) === 11000;
    const message = String(error?.message || "");
    const legacyKeyIndexConflict =
      duplicateKeyError && (message.includes(" key_1 ") || message.includes(" index: key_1 "));

    if (!legacyKeyIndexConflict) {
      throw error;
    }

    if (!legacyAppSettingsIndexChecked) {
      legacyAppSettingsIndexChecked = true;
      const indexes = await AppSettings.collection.indexes().catch(() => []);
      for (const index of indexes) {
        if (index?.name === "_id_") continue;
        if (index?.key && Object.prototype.hasOwnProperty.call(index.key, "key")) {
          await AppSettings.collection.dropIndex(index.name).catch(() => null);
        }
      }
    }

    return runUpsert();
  }
}

async function postJson(url, payload) {
  const body = JSON.stringify(payload);

  if (typeof fetch === "function") {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TELEGRAM_REQUEST_TIMEOUT_MS
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body,
      signal: controller.signal
    });

    try {
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }

      return {
        ok: response.ok,
        status: response.status,
        data: parsed
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let raw = "";

        response.on("data", (chunk) => {
          raw += chunk;
        });

        response.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            data: parsed
          });
        });
      }
    );

    request.setTimeout(TELEGRAM_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Telegram request timeout"));
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function isRateLimited(throttleKey, throttleMs) {
  const now = Date.now();
  const previous = Number(lastSentByThrottleKey.get(throttleKey) || 0);
  if (previous > 0 && now - previous < throttleMs) {
    return true;
  }

  lastSentByThrottleKey.set(throttleKey, now);
  return false;
}

async function sendTelegramMessage(text, options = {}) {
  try {
    const message = normalizeString(text);
    if (!message) {
      return {
        ok: false,
        skipped: true,
        reason: "empty_message"
      };
    }

    const scopedUserId = normalizeString(options?.userId);
    if (!options?.settingsDoc && !scopedUserId) {
      return {
        ok: false,
        skipped: true,
        reason: "missing_user_id"
      };
    }

    const settingsDoc =
      options?.settingsDoc || (await getOrCreateAppSettings(scopedUserId));
    let token = normalizeString(settingsDoc?.telegramBotToken);
    let chatId = normalizeString(settingsDoc?.telegramChatId);
    let enabled = Boolean(settingsDoc?.telegramEnabled);

    // Prefer scoped TelegramSettings credentials when this user owns Telegram panel config.
    // This keeps log notifications aligned with the latest dashboard Telegram setup.
    if (scopedUserId) {
      const telegramSettings = await TelegramSettings.findById(TELEGRAM_SETTINGS_ID)
        .select("botToken chatId userId")
        .lean()
        .catch(() => null);

      const ownerUserId = normalizeString(telegramSettings?.userId);
      if (ownerUserId && ownerUserId === scopedUserId) {
        const scopedToken = normalizeString(telegramSettings?.botToken);
        const scopedChatId = normalizeString(telegramSettings?.chatId);
        if (scopedToken && scopedChatId) {
          token = scopedToken;
          chatId = scopedChatId;
          enabled = true;
        }
      }
    }

    if (!options?.force && !enabled) {
      return {
        ok: false,
        skipped: true,
        reason: "disabled"
      };
    }

    if (!token || !chatId) {
      return {
        ok: false,
        skipped: true,
        reason: "missing_credentials"
      };
    }

    if (!isValidTelegramToken(token) || !isValidTelegramChatId(chatId)) {
      return {
        ok: false,
        skipped: true,
        reason: "invalid_credentials"
      };
    }

    const throttleKey = normalizeString(
      options?.throttleKey || options?.accountId || options?.email || scopedUserId || "global"
    );
    const throttleMs = Math.max(
      0,
      Number(options?.throttleMs || DEFAULT_THROTTLE_MS)
    );

    if (throttleMs > 0 && !options?.skipThrottle && isRateLimited(throttleKey, throttleMs)) {
      return {
        ok: false,
        skipped: true,
        reason: "throttled"
      };
    }

    const payload = {
      chat_id: chatId,
      text: message.slice(0, 3900),
      parse_mode: "HTML",
      disable_web_page_preview: true
    };

    const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await postJson(endpoint, payload);
    const apiOk = Boolean(response?.data?.ok);

    if (!response.ok || !apiOk) {
      console.warn("[TELEGRAM] Telegram send failed");
      return {
        ok: false,
        skipped: false,
        reason: "send_failed",
        status: response?.status || 0
      };
    }

    return {
      ok: true,
      skipped: false
    };
  } catch {
    console.warn("[TELEGRAM] Telegram send failed");
    return {
      ok: false,
      skipped: false,
      reason: "send_failed"
    };
  }
}

function shouldSendLogToTelegram(log) {
  const level = normalizeString(log?.level).toLowerCase();
  if (!["success", "warning", "error"].includes(level)) return false;

  const message = normalizeString(log?.message).toLowerCase();
  if (!message || message === "worker heartbeat" || message.includes("heartbeat")) {
    return false;
  }

  if (log?.metadata && log.metadata.telegram === false) {
    return false;
  }

  return true;
}

function formatTelegramLogMessage(log) {
  const level = normalizeString(log?.level).toLowerCase();
  const emojiByLevel = {
    success: "✅",
    warning: "⚠️",
    error: "❌"
  };
  const message = normalizeString(log?.message);

  if (!message) return "";
  if (!/^[A-Za-z0-9]/.test(message)) {
    return message;
  }

  const prefix = emojiByLevel[level] || "ℹ️";
  return `${prefix} ${message}`;
}

async function sendTelegramFromLog(log) {
  if (!shouldSendLogToTelegram(log)) {
    return {
      ok: false,
      skipped: true,
      reason: "not_eligible"
    };
  }

  const accountId = normalizeString(log?.accountId);
  const email = normalizeString(log?.email);
  const throttleKey = accountId || email || "global";

  return sendTelegramMessage(formatTelegramLogMessage(log), {
    throttleKey,
    userId: normalizeString(log?.userId)
  });
}

module.exports = {
  TELEGRAM_TOKEN_REGEX,
  TELEGRAM_CHAT_ID_REGEX,
  maskTelegramToken,
  isValidTelegramToken,
  isValidTelegramChatId,
  buildTelegramPublicConfig,
  getOrCreateAppSettings,
  sendTelegramMessage,
  sendTelegramFromLog
};

