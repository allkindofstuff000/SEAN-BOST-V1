const mongoose = require("mongoose");

const TELEGRAM_SETTINGS_ID = "singleton";

const telegramSettingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: TELEGRAM_SETTINGS_ID
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
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
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

module.exports = {
  TelegramSettings: mongoose.model("TelegramSettings", telegramSettingsSchema),
  TELEGRAM_SETTINGS_ID
};
