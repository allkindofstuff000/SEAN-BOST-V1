const { performance } = require("perf_hooks");

const configuredInterval = Number(process.env.EVENT_LOOP_LAG_INTERVAL_MS || 1000);
const MONITOR_INTERVAL_MS =
  Number.isFinite(configuredInterval) && configuredInterval > 50
    ? Math.floor(configuredInterval)
    : 1000;

let latestLagMs = 0;
let maxLagMs = 0;
let startedAt = Date.now();
let timer = null;

function startEventLoopLagMonitor() {
  if (timer) return;

  let expected = performance.now() + MONITOR_INTERVAL_MS;

  timer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    latestLagMs = Number(lag.toFixed(2));
    maxLagMs = Math.max(maxLagMs, latestLagMs);
    expected = now + MONITOR_INTERVAL_MS;
  }, MONITOR_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function getEventLoopLagMs() {
  return latestLagMs;
}

function getMaxEventLoopLagMs() {
  return maxLagMs;
}

function getEventLoopMonitorMeta() {
  return {
    intervalMs: MONITOR_INTERVAL_MS,
    startedAt: new Date(startedAt).toISOString()
  };
}

startEventLoopLagMonitor();

module.exports = {
  getEventLoopLagMs,
  getMaxEventLoopLagMs,
  getEventLoopMonitorMeta,
  startEventLoopLagMonitor
};
