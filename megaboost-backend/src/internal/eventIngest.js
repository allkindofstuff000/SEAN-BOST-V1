const crypto = require("crypto");
const express = require("express");
const { emitToUser, normalizeUserId } = require("../utils/socketEvents");

const router = express.Router();

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

  return String(req.body?.secret || "").trim();
}

router.post("/events", (req, res) => {
  const configuredSecret = String(process.env.INTERNAL_EVENT_SECRET || "").trim();
  if (!configuredSecret) {
    return res.status(503).json({
      ok: false,
      message: "INTERNAL_EVENT_SECRET is not configured"
    });
  }

  const providedSecret = resolveProvidedSecret(req);
  if (!safeSecretEquals(providedSecret, configuredSecret)) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized"
    });
  }

  const userId = normalizeUserId(req.body?.userId);
  const eventName = String(req.body?.eventName || "").trim();
  const payload = req.body?.payload;

  if (!userId || !eventName) {
    return res.status(400).json({
      ok: false,
      message: "userId and eventName are required"
    });
  }

  const io = req.app.get("io") || global.io;
  if (!io) {
    return res.status(503).json({
      ok: false,
      message: "Socket server not available"
    });
  }

  const emitted = emitToUser(io, userId, eventName, payload);
  return res.status(emitted ? 202 : 400).json({
    ok: emitted
  });
});

module.exports = router;
