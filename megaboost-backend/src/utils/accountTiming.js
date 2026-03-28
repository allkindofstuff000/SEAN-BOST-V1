const workerManager = require("../engine/workerGateway");
const { getOrCreateAppSettings } = require("./appSettings");
const {
  computeNextRunSchedule,
  buildScheduleDecisionLogPayload
} = require("./timing");

const TIMING_MANAGED_STATUSES = new Set([
  "running",
  "starting",
  "restarting",
  "active",
  "bumping",
  "waiting_cooldown",
  "retry_scheduled",
  "stalled"
]);

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldPersistManagedSchedule(account = {}) {
  return TIMING_MANAGED_STATUSES.has(normalizeStatus(account.status));
}

async function getTimingSettingsForUser(userId) {
  return getOrCreateAppSettings(userId);
}

function buildAccountSchedulePreview(account = {}, appSettings = {}, options = {}) {
  const now = options.now || new Date();
  const anchorAt = options.anchorAt || account.lastBumpAt || now;
  const schedule = computeNextRunSchedule({
    account,
    appSettings,
    now,
    anchorAt,
    workerState: account.workerState || {},
    additionalRuntimeMs: Number(options.additionalRuntimeMs || 0),
    randomValue: options.randomValue
  });

  const existingNextBumpAt = account?.nextBumpAt ? new Date(account.nextBumpAt) : null;
  const existingNextBumpAtMs =
    existingNextBumpAt && !Number.isNaN(existingNextBumpAt.valueOf())
      ? existingNextBumpAt.valueOf()
      : 0;
  const nowMs = new Date(now).valueOf();

  if (
    existingNextBumpAtMs > nowMs &&
    existingNextBumpAtMs > new Date(schedule.nextRunAt).valueOf()
  ) {
    return {
      ...schedule,
      nextRunAt: existingNextBumpAt,
      adjustedNextRunAtIso: existingNextBumpAt.toISOString(),
      nextDelayMs: Math.max(0, existingNextBumpAtMs - nowMs),
      decision: "wait_until_existing_schedule",
      reason: "preserved_existing_future_schedule"
    };
  }

  return schedule;
}

function buildManagedSchedulePatch(account = {}, schedule = {}, options = {}) {
  const clearInactive = Boolean(options.clearInactive);
  if (!shouldPersistManagedSchedule(account)) {
    return clearInactive
      ? {
          nextBumpAt: null,
          nextScheduledStart: null,
          nextBumpDelayMs: null
        }
      : {};
  }

  return {
    nextBumpAt: schedule.nextRunAt || null,
    nextBumpDelayMs: Number(schedule.nextDelayMs || 0),
    nextScheduledStart: schedule.nextRunAt || null
  };
}

async function requestWorkerReschedule(account = {}, schedule = {}, options = {}) {
  if (typeof workerManager.requestReschedule !== "function") {
    return null;
  }

  return workerManager.requestReschedule(account, {
    userId: options.userId || account.userId,
    reason: String(options.reason || "timing_settings_updated"),
    schedule: {
      nextBumpAt: schedule.nextRunAt || null,
      nextScheduledStart: schedule.nextRunAt || null,
      nextBumpDelayMs: Number(schedule.nextDelayMs || 0),
      debug: buildScheduleDecisionLogPayload(schedule)
    }
  });
}

module.exports = {
  TIMING_MANAGED_STATUSES,
  shouldPersistManagedSchedule,
  getTimingSettingsForUser,
  buildAccountSchedulePreview,
  buildManagedSchedulePatch,
  requestWorkerReschedule
};
