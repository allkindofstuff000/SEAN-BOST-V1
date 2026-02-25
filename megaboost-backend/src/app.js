const express = require("express");
const compression = require("compression");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const helmet = require("helmet");
const path = require("path");

const logRoutes = require("./routes/logRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const healthRoutes = require("./routes/health");
const internalEventIngestRoutes = require("./internal/eventIngest");
const { requireAuth } = require("./middleware/requireAuth");

const app = express();
app.set("trust proxy", 1);

const isProduction = process.env.NODE_ENV === "production";
const isDev = !isProduction;

const devAllowedOrigins = (
  process.env.FRONTEND_URLS ||
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isPrivateNetworkHost(hostname) {
  return (
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

function isAllowedDevOrigin(origin) {
  if (!isDev) return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";

    if (!isHttp) return false;

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return true;
    }

    return isPrivateNetworkHost(hostname);
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients or same-origin requests with no Origin header.
    if (!origin) return callback(null, true);
    if (devAllowedOrigins.includes(origin) || isAllowedDevOrigin(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

if (!isProduction) {
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
}
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cookieParser());

if (isProduction && String(process.env.ENABLE_REQUEST_TIMING_LOGS || "0") === "1") {
  const slowThresholdMs = Number(process.env.REQUEST_SLOW_THRESHOLD_MS || 1000);
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      if (elapsedMs >= slowThresholdMs) {
        console.log(
          `[HTTP SLOW] ${req.method} ${req.originalUrl} status=${res.statusCode} durationMs=${elapsedMs.toFixed(1)}`
        );
      }
    });

    next();
  });
}

app.get("/api/health", (_req, res) => {
  const time = new Date().toISOString();
  return res.status(200).json({
    status: "ok",
    app: "MEGABOOSTV1",
    time,
    ok: true,
    ts: time
  });
});

app.use("/api", healthRoutes);
app.use("/api/internal", internalEventIngestRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/logs", requireAuth, logRoutes);
app.use("/api/accounts", require("./routes/accountRoutes"));
app.use("/api/workers", requireAuth, require("./routes/workerRoutes"));
app.use("/api/license", require("./routes/licenseRoutes"));
app.use("/api/bump", requireAuth, require("./routes/bumpRoutes"));
app.use("/api/settings", requireAuth, settingsRoutes);

const frontendDistCandidates = [
  path.join(__dirname, "..", "frontend", "dist"),
  path.join(__dirname, "..", "..", "megaboost-dashboard", "dist"),
];
const logsDir = path.join(__dirname, "..", "logs");
app.use("/logs", express.static(logsDir));

const frontendDistPath = frontendDistCandidates.find((distPath) =>
  fs.existsSync(path.join(distPath, "index.html"))
);

if (frontendDistPath) {
  app.use(express.static(frontendDistPath));

  app.get("/", (req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
  });

  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.json({ message: "MegaBoost Backend Running" });
  });
}

app.use((err, req, res, next) => {
  console.error("Unhandled Express error:", err.stack || err.message);

  const payload = {
    message: err.message || "Internal Server Error"
  };

  if (process.env.NODE_ENV !== "production") {
    payload.error = err.stack || String(err);
  }

  res.status(err.status || 500).json(payload);
});

module.exports = app;
