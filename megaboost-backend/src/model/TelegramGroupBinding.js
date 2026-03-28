const mongoose = require("mongoose");

const telegramGroupBindingSchema = new mongoose.Schema(
  {
    chatId: {
      type: String,
      required: true,
      trim: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

telegramGroupBindingSchema.index({ userId: 1, chatId: 1 }, { unique: true });
telegramGroupBindingSchema.index({ userId: 1, accountId: 1 });

module.exports = mongoose.model("TelegramGroupBinding", telegramGroupBindingSchema);
