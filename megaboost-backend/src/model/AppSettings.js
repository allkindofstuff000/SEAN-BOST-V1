const mongoose = require("mongoose");
const {
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_LABEL,
  DEFAULT_UI_TIME_FORMAT
} = require("../utils/timing");

const appSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true
    },
    telegramEnabled: {
      type: Boolean,
      default: false
    },
    telegramBotToken: {
      type: String,
      trim: true,
      default: ""
    },
    telegramChatId: {
      type: String,
      trim: true,
      default: ""
    },
    telegramAdminUsernames: {
      type: String,
      trim: true,
      default: ""
    },
    telegramAdminIds: {
      type: String,
      trim: true,
      default: ""
    },
    timezone: {
      type: String,
      trim: true,
      default: DEFAULT_TIMEZONE
    },
    timezoneLabel: {
      type: String,
      trim: true,
      default: DEFAULT_TIMEZONE_LABEL
    },
    uiTimeFormat: {
      type: String,
      trim: true,
      enum: ["12h", "24h"],
      default: DEFAULT_UI_TIME_FORMAT
    }
  },
  {
    timestamps: true
  }
);

appSettingsSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model("AppSettings", appSettingsSchema);

