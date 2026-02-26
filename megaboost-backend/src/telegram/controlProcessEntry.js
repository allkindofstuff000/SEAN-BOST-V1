require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../../config/db");
const { startTelegramControlBot } = require("./controlBot");

let shuttingDown = false;
let botController = null;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[TELEGRAM-CONTROL] ${signal} received. Shutting down...`);

  try {
    if (botController && typeof botController.stop === "function") {
      await botController.stop();
    }
  } catch (error) {
    exitCode = 1;
    console.error("[TELEGRAM-CONTROL] Failed to stop bot:", error.message);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log("[TELEGRAM-CONTROL] MongoDB connection closed.");
    }
  } catch (error) {
    exitCode = 1;
    console.error("[TELEGRAM-CONTROL] Failed to close MongoDB connection:", error.message);
  }

  process.exit(exitCode);
}

async function start() {
  try {
    await connectDB();
    botController = await startTelegramControlBot();

    if (!botController?.started) {
      console.warn(
        `[TELEGRAM-CONTROL] Bot is disabled (${botController?.reason || "not_started"}). Process will stay idle.`
      );
    }
  } catch (error) {
    console.error(`[TELEGRAM-CONTROL] Failed to start: ${error.stack || error.message}`);
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
  console.error(`[TELEGRAM-CONTROL] Unhandled rejection: ${message}`);
  shutdown("UNHANDLED_REJECTION", 1).catch(() => process.exit(1));
});

process.on("uncaughtException", (error) => {
  console.error(`[TELEGRAM-CONTROL] Uncaught exception: ${error.stack || error.message}`);
  shutdown("UNCAUGHT_EXCEPTION", 1).catch(() => process.exit(1));
});
