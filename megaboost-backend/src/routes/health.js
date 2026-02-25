const express = require("express");
const mongoose = require("mongoose");
const workerGateway = require("../engine/workerGateway");
const {
  getEventLoopLagMs,
  getEventLoopMonitorMeta,
  getMaxEventLoopLagMs
} = require("../utils/eventLoopLag");

const router = express.Router();

const DB_HEALTH_TIMEOUT_MS = Number(process.env.DB_HEALTH_TIMEOUT_MS || 2000);

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function getConnectedSocketsCount(io) {
  if (!io) return 0;
  const namespace = io.of("/");
  if (namespace?.sockets && typeof namespace.sockets.size === "number") {
    return namespace.sockets.size;
  }
  if (io.engine && typeof io.engine.clientsCount === "number") {
    return io.engine.clientsCount;
  }
  return 0;
}

router.get("/health", (_req, res) => {
  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptimeSec: Number(process.uptime().toFixed(2))
  });
});

router.get("/health/db", async (_req, res) => {
  const readyState = mongoose.connection.readyState;
  const readyStateLabel =
    readyState === 1
      ? "connected"
      : readyState === 2
        ? "connecting"
        : readyState === 3
          ? "disconnecting"
          : "disconnected";

  if (readyState !== 1) {
    return res.status(503).json({
      ok: false,
      db: {
        readyState,
        state: readyStateLabel
      }
    });
  }

  const startedAt = Date.now();
  try {
    await withTimeout(mongoose.connection.db.admin().ping(), DB_HEALTH_TIMEOUT_MS);
    const durationMs = Date.now() - startedAt;
    return res.status(200).json({
      ok: true,
      db: {
        readyState,
        state: readyStateLabel,
        pingMs: durationMs
      }
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      db: {
        readyState,
        state: readyStateLabel,
        error: error.message
      }
    });
  }
});

router.get("/metrics", async (req, res) => {
  let workerStatus = null;
  let workerError = "";

  try {
    workerStatus = await workerGateway.getWorkerStatus();
  } catch (error) {
    workerError = error.message || "Failed to load worker status";
  }

  const io = req.app.get("io") || global.io;

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Number(process.uptime().toFixed(2)),
    memory: process.memoryUsage(),
    cpuUsage: process.cpuUsage(),
    eventLoopLagMs: getEventLoopLagMs(),
    eventLoopLagMaxMs: getMaxEventLoopLagMs(),
    eventLoopMonitor: getEventLoopMonitorMeta(),
    activeWorkers: Number(workerStatus?.running || 0),
    queueSize: Number(workerStatus?.queued || 0),
    connectedSockets: getConnectedSocketsCount(io),
    workerStatus: workerStatus || null,
    workerError: workerError || null
  });
});

module.exports = router;
