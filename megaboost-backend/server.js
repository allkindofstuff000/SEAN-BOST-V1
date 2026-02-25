require("dotenv").config();
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const connectDB = require("./config/db");
const workerManager = require("./src/engine/workerGateway");
const Account = require("./src/model/Account");
const User = require("./src/model/User");
const { AUTH_COOKIE_NAME, verifyAuthToken } = require("./src/utils/authToken");
const { getUserRoom } = require("./src/utils/socketEvents");

const app = require("./src/app");

const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 5000);
const DEFAULT_HOST = isProduction ? "127.0.0.1" : "0.0.0.0";
const HOST = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
const defaultDevOrigins = "http://localhost:5173,http://127.0.0.1:5173";

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function parseOrigins(rawList) {
  return String(rawList || "")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

const configuredFrontendOrigins = parseOrigins(process.env.FRONTEND_URLS || "");
const socketAllowedOrigins = configuredFrontendOrigins.length > 0
  ? configuredFrontendOrigins
  : isProduction
    ? [normalizeOrigin(process.env.APP_ORIGIN)].filter(Boolean)
    : parseOrigins(defaultDevOrigins);

if (isProduction && socketAllowedOrigins.length === 0) {
  throw new Error("FRONTEND_URLS or APP_ORIGIN is required in production");
}

function isSocketOriginAllowed(origin) {
  if (!origin) return true;
  return socketAllowedOrigins.includes(normalizeOrigin(origin));
}

const server = http.createServer(app);
server.requestTimeout = parsePositiveNumber(process.env.SERVER_REQUEST_TIMEOUT_MS, 65000);
server.headersTimeout = parsePositiveNumber(process.env.SERVER_HEADERS_TIMEOUT_MS, 66000);
server.keepAliveTimeout = parsePositiveNumber(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS, 65000);

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isSocketOriginAllowed(origin)) {
        return callback(null, true);
      }

      console.warn(`[SOCKET CORS] Blocked origin: ${origin}`);
      return callback(new Error(`Not allowed by Socket.IO CORS: ${origin}`));
    },
    credentials: true
  }
});

// Make io globally accessible
global.io = io;

app.set("io", io);

function parseCookies(rawCookieHeader = "") {
  const result = {};
  const raw = String(rawCookieHeader || "").trim();
  if (!raw) return result;

  const parts = raw.split(";");
  for (const part of parts) {
    const segment = String(part || "").trim();
    if (!segment) continue;
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex < 1) continue;
    const name = segment.slice(0, separatorIndex).trim();
    const value = segment.slice(separatorIndex + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(value || "");
    } catch {
      result[name] = value || "";
    }
  }

  return result;
}

function readBearerToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.toLowerCase().startsWith("bearer ")) {
    return raw.slice(7).trim();
  }
  return raw;
}

function resolveSocketToken(socket) {
  const cookies = parseCookies(socket?.handshake?.headers?.cookie || "");
  const cookieToken = String(cookies[AUTH_COOKIE_NAME] || "").trim();
  if (cookieToken) return cookieToken;

  const authToken = readBearerToken(socket?.handshake?.auth?.token);
  if (authToken) return authToken;

  const headerToken = readBearerToken(socket?.handshake?.headers?.authorization);
  return headerToken;
}

io.use(async (socket, next) => {
  try {
    const token = resolveSocketToken(socket);
    if (!token) {
      return next(new Error("Authentication required"));
    }

    const payload = verifyAuthToken(token);
    const userId = String(payload?.sub || "").trim();
    if (!userId) {
      return next(new Error("Invalid auth payload"));
    }

    const user = await User.findById(userId)
      .select("_id username email role isActive licenseId")
      .lean();
    if (!user || user.isActive === false) {
      return next(new Error("Authentication required"));
    }

    socket.data.user = user;
    return next();
  } catch {
    return next(new Error("Authentication required"));
  }
});

io.on("connection", (socket) => {
  const userId = String(socket.data?.user?._id || "").trim();
  if (!userId) {
    socket.disconnect(true);
    return;
  }

  socket.join(getUserRoom(userId));
  console.log(`Client connected: ${socket.id} user=${userId}`);

  socket.on("restart_account", async (payload = {}, ack) => {
    const accountId = String(payload?.accountId || "").trim();
    if (!accountId) {
      const response = {
        success: false,
        message: "accountId is required"
      };
      if (typeof ack === "function") ack(response);
      return;
    }

    const socketIp =
      socket.handshake?.address ||
      socket.request?.socket?.remoteAddress ||
      "";

    try {
      const account = await Account.findOne({ _id: accountId, userId });
      if (!account) {
        const response = {
          success: false,
          message: "Account not found"
        };
        if (typeof ack === "function") ack(response);
        return;
      }

      const result = await workerManager.restartAccount(account, {
        ip: socketIp,
        userId,
        stopTimeoutMs: 5000,
        restartDelayMs: 3000
      });

      const response = {
        success: true,
        data: result || { accountId, status: "starting" }
      };

      if (typeof ack === "function") ack(response);
    } catch (error) {
      const response = {
        success: false,
        message: error?.message || "Failed to restart account"
      };
      if (typeof ack === "function") ack(response);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id} user=${userId}`);
  });
});

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10000;

function closeHttpServer() {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[SHUTDOWN] ${signal} received. Starting graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.error("[SHUTDOWN] Timed out. Forcing exit.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    if (typeof workerManager.shouldManageWorkerLifecycle === "function" &&
      workerManager.shouldManageWorkerLifecycle()) {
      await workerManager.stopAll();
      console.log("[SHUTDOWN] Workers stopped.");
    }
  } catch (error) {
    exitCode = 1;
    console.error("[SHUTDOWN] Failed to stop workers:", error.message);
  }

  try {
    await closeHttpServer();
    console.log("[SHUTDOWN] HTTP server closed.");
  } catch (error) {
    exitCode = 1;
    console.error("[SHUTDOWN] Failed to close HTTP server:", error.message);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log("[SHUTDOWN] MongoDB connection closed.");
    }
  } catch (error) {
    exitCode = 1;
    console.error("[SHUTDOWN] Failed to close MongoDB connection:", error.message);
  }

  clearTimeout(forceExitTimer);
  process.exit(exitCode);
}

async function startServer() {
  try {
    await connectDB();
    server.listen(PORT, HOST, () => {
      console.log(`Server running on ${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

startServer();

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(`[SHUTDOWN] SIGINT handler failed: ${error.message}`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(`[SHUTDOWN] SIGTERM handler failed: ${error.message}`);
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[PROCESS] Unhandled rejection: ${message}`);
  shutdown("UNHANDLED_REJECTION", 1).catch(() => process.exit(1));
});

process.on("uncaughtException", (error) => {
  console.error(`[PROCESS] Uncaught exception: ${error.stack || error.message}`);
  shutdown("UNCAUGHT_EXCEPTION", 1).catch(() => process.exit(1));
});
