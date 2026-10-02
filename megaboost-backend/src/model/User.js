const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 64
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ["admin", "user"],
      default: "user",
      index: true
    },
    licenseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "License",
      default: null
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    language: {
      type: String,
      enum: ["en", "es"],
      default: "en"
    }
  },
  {
    timestamps: true
  }
);

// (email & username already get unique indexes from their field definitions;
// re-declaring them here created duplicate/conflicting index specs that can
// abort syncIndexes with IndexKeySpecsConflict.)

module.exports = mongoose.model("User", userSchema);
