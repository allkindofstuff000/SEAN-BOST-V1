require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const connectDB = require("../../config/db");
const Account = require("../model/Account");

const PROCESS_ROLE = "worker";
process.env.PROCESS_ROLE = PROCESS_ROLE;

const workerManager = require("./worker");

const HOST = String(process.env.WORKER_COMMAND_HOST || "127.0.0.1").trim() || "127.0.0.1";
const INTERNAL_EVENT_SECRET = String(process.env.INTERNAL_EVENT_SECRET || "").trim();

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const PORT = parsePositiveNumber(process.env.WORKER_COMMAND_PORT, 5001);

const REQUEST_TIMEOUT_MS = parsePositiveNumber(process.env.SERVER_REQUEST_TIMEOUT_MS, 65000);
const HEADERS_TIMEOUT_MS = parsePositiveNumber(process.env.SERVER_HEADERS_TIMEOUT_MS, 66000);
const KEEP_ALIVE_TIMEOUT_MS = parsePositiveNumber(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS, 65000);

function normalizeUserId(userId) {
  return String(userId || "").trim();
}

function normalizeAccountId(accountOrId) {
  if (!accountOrId) return "";
  if (typeof accountOrId === "string") return accountOrId.trim();
  return String(accountOrId._id || accountOrId.id || "").trim();
}

function safeSecretEquals(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function resolveProvidedSecret(req) {
  const headerSecret = String(req.headers["x-internal-event-secret"] || "").trim();
  if (headerSecret) return headerSecret;
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
}

async function findScopedAccount(accountId, userId = "") {
  const query = {
    _id: accountId
  };

  const scopedUserId = normalizeUserId(userId);
  if (scopedUserId) {
    query.userId = scopedUserId;
  }

  return Account.findOne(query);
}

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    if (!INTERNAL_EVENT_SECRET) {
      return res.status(503).json({
        success: false,
        message: "INTERNAL_EVENT_SECRET is not configured"
      });
    }

    const provided = resolveProvidedSecret(req);
    if (!safeSecretEquals(provided, INTERNAL_EVENT_SECRET)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized"
      });
    }

    return next();
  });

  app.get("/internal/worker/health", (_req, res) => {
    return res.status(200).json({
      success: true,
      data: {
        role: PROCESS_ROLE,
        pid: process.pid,
        uptimeSec: Number(process.uptime().toFixed(2))
      }
    });
  });

  app.get("/internal/worker/status", async (req, res) => {
    try {
      const userId = normalizeUserId(req.query?.userId);
      const status = workerManager.getWorkerStatus({ userId });
      return res.status(200).json({
        success: true,
        data: status
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/request-start", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const userId = normalizeUserId(req.body?.userId);
      const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};

      if (!accountId) {
        return res.status(400).json({
          success: false,
          message: "accountId is required"
        });
      }

      const account = await findScopedAccount(accountId, userId);
      if (!account) {
        return res.status(404).json({
          success: false,
          message: "Account not found"
        });
      }

      const result = await workerManager.requestStart(account, {
        ...options,
        userId: userId || account.userId
      });

      return res.status(200).json({
        success: true,
        data: result || {
          accountId,
          status: "starting"
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/request-stop", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const userId = normalizeUserId(req.body?.userId);
      const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};

      if (!accountId) {
        return res.status(400).json({
          success: false,
          message: "accountId is required"
        });
      }

      const result = await workerManager.requestStop(accountId, {
        ...options,
        userId
      });

      return res.status(200).json({
        success: true,
        data: result || {
          accountId,
          status: "stopped"
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/restart", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const userId = normalizeUserId(req.body?.userId);
      const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};

      if (!accountId) {
        return res.status(400).json({
          success: false,
          message: "accountId is required"
        });
      }

      const account = await findScopedAccount(accountId, userId);
      if (!account) {
        return res.status(404).json({
          success: false,
          message: "Account not found"
        });
      }

      const result = await workerManager.restartAccount(account, {
        ...options,
        userId: userId || account.userId
      });

      return res.status(200).json({
        success: true,
        data: result || {
          accountId,
          status: "restarting"
        }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/stop-all", async (req, res) => {
    try {
      const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
      const result = await workerManager.stopAll(options);
      return res.status(200).json({
        success: true,
        data: result || { stopped: true }
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/reset-retry", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const userId = normalizeUserId(req.body?.userId);
      const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};

      if (!accountId) {
        return res.status(400).json({
          success: false,
          message: "accountId is required"
        });
      }

      const result = await workerManager.resetRetry(accountId, {
        ...options,
        userId
      });

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/submit-verification", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const code = String(req.body?.code || "").trim();

      if (!accountId || !code) {
        return res.status(400).json({
          success: false,
          message: "accountId and code are required"
        });
      }

      const result = await workerManager.submitVerificationCode(accountId, code);
      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/run-account", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const userId = normalizeUserId(req.body?.userId);

      if (!accountId) {
        return res.status(400).json({
          success: false,
          message: "accountId is required"
        });
      }

      const account = await findScopedAccount(accountId, userId);
      if (!account) {
        return res.status(404).json({
          success: false,
          message: "Account not found"
        });
      }

      const result = await workerManager.runAccount(account);
      return res.status(200).json({
        success: true,
        data: result || null
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post("/internal/worker/test-connection", async (req, res) => {
    try {
      const accountId = normalizeAccountId(req.body?.accountId);
      const userId = normalizeUserId(req.body?.userId);

      if (!accountId) {
        return res.status(400).json({
          success: false,
          message: "accountId is required"
        });
      }

      const account = await findScopedAccount(accountId, userId);
      if (!account) {
        return res.status(404).json({
          success: false,
          message: "Account not found"
        });
      }

      const result = await workerManager.testProxyNavigation(account);
      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

  app.use((error, _req, res, _next) => {
    return res.status(500).json({
      success: false,
      message: error?.message || "Internal worker error"
    });
  });

  return app;
}

const app = createApp();
let server = null;

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10000;

async function closeHttpServer() {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[WORKER] ${signal} received. Shutting down...`);

  const forceExitTimer = setTimeout(() => {
    console.error("[WORKER] Shutdown timed out. Forcing exit.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    await workerManager.stopAll();
  } catch (error) {
    exitCode = 1;
    console.error("[WORKER] Failed to stop workers:", error.message);
  }

  try {
    await closeHttpServer();
  } catch (error) {
    exitCode = 1;
    console.error("[WORKER] Failed to close command server:", error.message);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  } catch (error) {
    exitCode = 1;
    console.error("[WORKER] Failed to close MongoDB connection:", error.message);
  }

  clearTimeout(forceExitTimer);
  process.exit(exitCode);
}

async function start() {
  try {
    await connectDB();

    server = app.listen(PORT, HOST, () => {
      console.log(`[WORKER] Command server listening on ${HOST}:${PORT}`);
    });

    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  } catch (error) {
    console.error(`[WORKER] Failed to start: ${error.message}`);
    process.exit(1);
  }
}

start();

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[WORKER] Unhandled rejection: ${message}`);
  shutdown("UNHANDLED_REJECTION", 1).catch(() => process.exit(1));
});

process.on("uncaughtException", (error) => {
  console.error(`[WORKER] Uncaught exception: ${error.stack || error.message}`);
  shutdown("UNCAUGHT_EXCEPTION", 1).catch(() => process.exit(1));
});
