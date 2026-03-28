const AppSettings = require("../model/AppSettings");
const {
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_LABEL,
  DEFAULT_UI_TIME_FORMAT,
  resolveAppTimingSettings
} = require("./timing");

let legacyAppSettingsIndexChecked = false;

function normalizeString(value) {
  return String(value || "").trim();
}

async function ensureLegacyIndexes() {
  if (legacyAppSettingsIndexChecked) {
    return;
  }

  legacyAppSettingsIndexChecked = true;
  const indexes = await AppSettings.collection.indexes().catch(() => []);
  for (const index of indexes) {
    if (index?.name === "_id_") continue;
    if (index?.key && Object.prototype.hasOwnProperty.call(index.key, "key")) {
      await AppSettings.collection.dropIndex(index.name).catch(() => null);
    }
  }
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
          telegramChatId: "",
          telegramAdminUsernames: "",
          telegramAdminIds: "",
          timezone: DEFAULT_TIMEZONE,
          timezoneLabel: DEFAULT_TIMEZONE_LABEL,
          uiTimeFormat: DEFAULT_UI_TIME_FORMAT
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

    await ensureLegacyIndexes();
    return runUpsert();
  }
}

function sanitizeAppTimingPatch(patch = {}) {
  const timing = resolveAppTimingSettings(patch || {});
  return {
    timezone: timing.timezone,
    timezoneLabel: timing.timezoneLabel,
    uiTimeFormat: timing.uiTimeFormat
  };
}

function buildAppSettingsPublicPayload(settings = {}) {
  const timing = resolveAppTimingSettings(settings || {});
  return {
    timezone: timing.timezone,
    timezoneLabel: timing.timezoneLabel,
    uiTimeFormat: timing.uiTimeFormat
  };
}

module.exports = {
  getOrCreateAppSettings,
  sanitizeAppTimingPatch,
  buildAppSettingsPublicPayload
};
