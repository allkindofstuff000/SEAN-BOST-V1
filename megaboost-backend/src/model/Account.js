const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema({

  email: {
    type: String,
    required: true
  },

  password: {
    type: String,
    required: true
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  proxyHost: String,
  proxyPort: Number,
  proxyUsername: String,
  proxyPassword: String,
  proxyType: {
    type: String,
    enum: ["http", "socks5"],
    default: "http"
  },

  userAgent: String,
  locale: {
    type: String,
    default: "en-US"
  },
  timezone: {
    type: String,
    default: "Asia/Dhaka"
  },
  screenWidth: {
    type: Number,
    min: 800,
    max: 3840
  },
  screenHeight: {
    type: Number,
    min: 600,
    max: 2160
  },
  disableWebRtc: {
    type: Boolean,
    default: true
  },
  autoRestartCrashed: {
    type: Boolean,
    default: true
  },

  status: {
    type: String,
    enum: [
      "pending",
      "running",
      "starting",
      "restarting",
      "active",
      "bumping",
      "waiting_cooldown",
      "retry_scheduled",
      "stalled",
      "awaiting_captcha",
      "awaiting_verification_code",
      "awaiting_2fa",
      "needs2fa",
      "completed",
      "paused",
      "crashed",
      "banned",
      "verification_failed",
      "2fa_failed",
      "login_failed",
      "proxy_failed",
      "blocked",
      "stopped",
      "error"
    ],
    default: "pending"
  },

  workerState: {
    failureCount: {
      type: Number,
      default: 0
    },
    lastErrorMessage: {
      type: String
    },
    lastErrorAt: {
      type: Date
    },
    nextRetryAt: {
      type: Date
    },
    blockedReason: {
      type: String
    },
    dailyRuntimeDayKey: {
      type: String,
      default: ""
    },
    dailyRuntimeUsedMs: {
      type: Number,
      default: 0
    }
  },

  captchaUrl: String,
  captchaRequestedAt: Date,
  verificationCurrentUrl: String,
  verificationScreenshotPath: String,
  verificationRequestedAt: Date,

  // 🔥 Bump Configuration
  maxDailyBumps: {
    type: Number,
    default: 10
  },

  baseInterval: {
    type: Number,
    default: 30
  },

  baseIntervalMinutes: {
    type: Number,
    default: 30
  },

  randomMin: {
    type: Number,
    default: 0
  },

  randomMinMinutes: {
    type: Number,
    default: 0
  },

  randomMax: {
    type: Number,
    default: 5
  },

  randomMaxMinutes: {
    type: Number,
    default: 5
  },

  runtimeStart: {
    type: String,
    default: "00:00"
  },

  runtimeEnd: {
    type: String,
    default: "23:59"
  },

  runtimeWindow: {
    type: String,
    default: "00:00-23:59"
  },

  maxDailyRuntime: {
    type: Number,
    default: 8
  },

  maxDailyRuntimeHours: {
    type: Number,
    default: 8
  },

  cookiesSavedAt: Date,

  lastCooldownDetected: Date,
  cooldownMinutes: Number,
  waitingUntil: Date,

  lastBumpAt: Date,
  nextBumpAt: Date,
  nextBumpDelayMs: Number,
  nextScheduledStart: Date,

  totalBumpsToday: {
    type: Number,
    default: 0
  },

  connectionTest: {
    success: {
      type: Boolean,
      default: false
    },
    testedAt: Date,
    proxyIp: String,
    finalUrl: String,
    pageTitle: String,
    error: String
  }

}, { timestamps: true });

module.exports = mongoose.model("Account", accountSchema);
