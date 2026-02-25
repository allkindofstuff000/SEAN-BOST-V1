require("dotenv").config();

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const Log = require("../src/model/Log");

async function run() {
  await connectDB();

  const result = await Log.deleteMany({
    message: "Worker heartbeat"
  });

  const remaining = await Log.countDocuments({
    message: "Worker heartbeat"
  });

  console.log(
    `[CLEANUP] Deleted ${result.deletedCount || 0} "Worker heartbeat" log entries`
  );
  console.log(`[CLEANUP] Remaining "Worker heartbeat" entries: ${remaining}`);
}

run()
  .catch((error) => {
    console.error("[CLEANUP] Failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {}
  });
