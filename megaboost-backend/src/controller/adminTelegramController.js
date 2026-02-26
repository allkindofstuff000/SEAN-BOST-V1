const {
  buildTelegramAdminPayload,
  getTelegramControlConfig,
  updateTelegramControlSettings
} = require("../telegram/controlSettings");

function isValidationError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("chatId") ||
    message.includes("TELEGRAM_BOT_TOKEN") ||
    message.includes("TELEGRAM_DEFAULT_USER")
  );
}

async function getAdminTelegramSettings(_req, res) {
  try {
    const config = await getTelegramControlConfig();
    return res.status(200).json(buildTelegramAdminPayload(config));
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to load Telegram settings"
    });
  }
}

async function updateAdminTelegramSettings(req, res) {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const config = await updateTelegramControlSettings(payload);
    return res.status(200).json(buildTelegramAdminPayload(config));
  } catch (error) {
    const status = isValidationError(error) ? 400 : 500;
    return res.status(status).json({
      message: error.message || "Failed to update Telegram settings"
    });
  }
}

module.exports = {
  getAdminTelegramSettings,
  updateAdminTelegramSettings
};
