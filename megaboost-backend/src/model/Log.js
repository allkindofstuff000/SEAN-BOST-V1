const mongoose = require("mongoose");

const logSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    level: {
      type: String,
      enum: ["success", "warning", "error", "info"],
      required: true,
      index: true
    },

    message: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      index: true
    },

    ip: {
      type: String,
      index: true
    },

    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account"
    },

    metadata: {
      type: Object
    }
  },
  {
    timestamps: true // adds createdAt & updatedAt automatically
  }
);

// Text index for search in message/email.
logSchema.index({ message: "text", email: "text" });
// Newest-first query index.
logSchema.index({ userId: 1, createdAt: -1 });
// Common filter + sort index.
logSchema.index({ userId: 1, level: 1, createdAt: -1 });
// Common email filter + sort index.
logSchema.index({ userId: 1, email: 1, createdAt: -1 });

module.exports = mongoose.model("Log", logSchema);
