const mongoose = require("mongoose");

const telegramSettingsSchema = new mongoose.Schema(
  {
    // Compatibility: allow legacy string ids like "singleton" while defaulting new docs to ObjectId.
    _id: {
      type: mongoose.Schema.Types.Mixed,
      default: () => new mongoose.Types.ObjectId()
    },
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
  TelegramSettings: mongoose.model("TelegramSettings", telegramSettingsSchema)
};
