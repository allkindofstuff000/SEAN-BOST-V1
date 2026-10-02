const mongoose = require("mongoose");

const logSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    level: {
      type: String,
      enum: ["success", "warning", "error", "info"],
      required: true
    },

    message: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String
    },

    ip: {
      type: String
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

// Tenant-scoped text search (message/email). Only one text index per collection.
logSchema.index({ userId: 1, message: "text", email: "text" }, { name: "userId_text" });
// Newest-first list — includes _id so the `.sort({ createdAt:-1, _id:-1 })` the
// controller uses is fully covered by the index (no in-memory SORT stage).
logSchema.index({ userId: 1, createdAt: -1, _id: -1 });
// Level filter + sort.
logSchema.index({ userId: 1, level: 1, createdAt: -1, _id: -1 });
// Email filter + sort.
logSchema.index({ userId: 1, email: 1, createdAt: -1, _id: -1 });
// Auto-expire logs after 30 days (retention) so the collection stays bounded.
logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model("Log", logSchema);
