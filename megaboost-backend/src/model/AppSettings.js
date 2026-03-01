const mongoose = require("mongoose");

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
    }
  },
  {
    timestamps: true
  }
);

appSettingsSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model("AppSettings", appSettingsSchema);

