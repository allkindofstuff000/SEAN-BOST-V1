const mongoose = require("mongoose");

// Legacy singleton id kept for compatibility/migration checks.
const TELEGRAM_SETTINGS_ID = "singleton";

const telegramSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      unique: true
    },
    botToken: {
      type: String,
      default: "",
      trim: true
    },
    chatId: {
      type: String,
      default: "",
      trim: true
    },
    panelMessageId: {
      type: Number,
      default: null
    }
  },
  {
    timestamps: {
      createdAt: false,
      updatedAt: "updatedAt"
    }
  }
);

telegramSettingsSchema.index({ userId: 1 }, { unique: true });

module.exports = {
  TelegramSettings: mongoose.model("TelegramSettings", telegramSettingsSchema),
  TELEGRAM_SETTINGS_ID
};
