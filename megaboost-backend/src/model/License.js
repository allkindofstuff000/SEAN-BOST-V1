const mongoose = require("mongoose");

const licenseSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    maxAccounts: {
      type: Number,
      required: true,
      min: 1
    },
    expiresAt: {
      type: Date,
      required: true
    },
    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
      index: true
    },
    notes: {
      type: String,
      default: "",
      trim: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  {
    timestamps: true
  }
);

licenseSchema.virtual("isExpired").get(function getIsExpired() {
  const expiresAt = this.expiresAt instanceof Date ? this.expiresAt : new Date(this.expiresAt);
  if (Number.isNaN(expiresAt.valueOf())) return true;
  return Date.now() > expiresAt.valueOf();
});

module.exports = mongoose.model("License", licenseSchema);
