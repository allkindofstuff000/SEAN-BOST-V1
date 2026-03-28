const { DateTime } = require("luxon");
const {
  DEFAULT_RUNTIME_START,
  DEFAULT_RUNTIME_END,
  TIME_24H_PATTERN,
  TIME_12H_PATTERN,
  RUNTIME_WINDOW_PATTERN,
  buildRuntimeWindow,
  format24HourTo12Hour,
  getNextRuntimeStart,
  isInsideRuntimeWindow,
  parseRuntimeTime,
  parseRuntimeWindow: parseRuntimeWindowConfig,
  resolveRuntimeWindowConfig
} = require("./runtimeWindow");

const DEFAULT_TIMEZONE = "Asia/Dhaka";
const DEFAULT_TIMEZONE_LABEL = "BDT (UTC+6)";
const DEFAULT_UI_TIME_FORMAT = "12h";
const DEFAULT_RUNTIME_WINDOW = "00:00-23:59";
const RUNTIME_CLOCK_PATTERN_24H = TIME_24H_PATTERN;
const RUNTIME_CLOCK_PATTERN_12H = TIME_12H_PATTERN;

const QUICK_BUMP_PRESETS = {
  conservative: {
    key: "conservative",
    name: "Conservative",
    baseInterval: 45,
    randomMin: 5,
    randomMax: 10,
    runtimeWindow: DEFAULT_RUNTIME_WINDOW
  },
  standard: {
    key: "standard",
    name: "Standard",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: DEFAULT_RUNTIME_WINDOW
  },
  aggressive: {
    key: "aggressive",
    name: "Aggressive",
    baseInterval: 15,
    randomMin: 0.5,
    randomMax: 3,
    runtimeWindow: DEFAULT_RUNTIME_WINDOW
  },
  business_hours: {
    key: "business_hours",
    name: "Business Hours",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: "09:00-17:00"
  }
};

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToMs(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizeTimezone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return DEFAULT_TIMEZONE;
  const probe = DateTime.now().setZone(candidate);
  return probe.isValid ? candidate : DEFAULT_TIMEZONE;
}

function normalizeUiTimeFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "24h" ? "24h" : DEFAULT_UI_TIME_FORMAT;
}

function normalizeTimezoneLabel(value) {
  const normalized = String(value || "").trim();
  return normalized || DEFAULT_TIMEZONE_LABEL;
}

function getShortTimezoneLabel(value) {
  const label = normalizeTimezoneLabel(value);
  return label.split("(")[0].trim() || "BDT";
}

function resolveAppTimingSettings(appSettings = {}) {
  return {
    timezone: normalizeTimezone(appSettings.timezone),
    timezoneLabel: normalizeTimezoneLabel(appSettings.timezoneLabel),
    uiTimeFormat: normalizeUiTimeFormat(appSettings.uiTimeFormat)
  };
}

function parseRuntimeWindow(windowValue = DEFAULT_RUNTIME_WINDOW) {
  return parseRuntimeWindowConfig(windowValue || DEFAULT_RUNTIME_WINDOW);
}

function toDateTime(value, timezone = DEFAULT_TIMEZONE) {
  if (DateTime.isDateTime(value)) {
    return value.setZone(normalizeTimezone(timezone));
  }

  const zone = normalizeTimezone(timezone);

  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: "utc" }).setZone(zone);
  }

  if (typeof value === "number") {
    return DateTime.fromMillis(value, { zone: "utc" }).setZone(zone);
  }

  const raw = String(value || "").trim();
  if (!raw) {
    return DateTime.now().setZone(zone);
  }

  let parsed = DateTime.fromISO(raw, { zone: "utc" });
  if (!parsed.isValid) {
    parsed = DateTime.fromJSDate(new Date(raw), { zone: "utc" });
  }
  if (!parsed.isValid) {
    return DateTime.now().setZone(zone);
  }

  return parsed.setZone(zone);
}

function toIso(value, timezone = DEFAULT_TIMEZONE) {
  return toDateTime(value, timezone).toUTC().toISO();
}

function formatDateTimeForAdmin(value, appSettings = {}, options = {}) {
  if (!value) return "-";
  const timing = resolveAppTimingSettings(appSettings);
  const dateTime = toDateTime(value, timing.timezone);
  if (!dateTime.isValid) return "-";

  const includeSeconds = options.includeSeconds !== false;
  const includeDate = options.includeDate !== false;
  const includeTimezone = options.includeTimezone !== false;
  const pattern =
    timing.uiTimeFormat === "24h"
      ? includeSeconds
        ? "HH:mm:ss"
        : "HH:mm"
      : includeSeconds
        ? "hh:mm:ss a"
        : "hh:mm a";
  const datePrefix = includeDate ? "MM/dd/yyyy, " : "";
  const labelSuffix = includeTimezone ? ` ${getShortTimezoneLabel(timing.timezoneLabel)}` : "";

  return `${dateTime.toFormat(`${datePrefix}${pattern}`)}${labelSuffix}`;
}

function formatRuntimeWindowForAdmin(windowValue, appSettings = {}) {
  const parsed = parseRuntimeWindow(windowValue);
  if (!parsed.valid) return DEFAULT_RUNTIME_WINDOW;

  const timing = resolveAppTimingSettings(appSettings);
  const formatter =
    timing.uiTimeFormat === "24h"
      ? "HH:mm"
      : "hh:mm a";

  const start = DateTime.fromObject(
    {
      year: 2026,
      month: 1,
      day: 1,
      hour: parsed.startHour,
      minute: parsed.startMinute
    },
    { zone: timing.timezone }
  );
  const end = DateTime.fromObject(
    {
      year: 2026,
      month: 1,
      day: 1,
      hour: parsed.endHour,
      minute: parsed.endMinute
    },
    { zone: timing.timezone }
  );

  return `${start.toFormat(formatter)} - ${end.toFormat(formatter)}`;
}

function parseRuntimeClockParts(value) {
  const parsed = parseRuntimeTime(value);
  if (!parsed) {
    return null;
  }

  return {
    hour24: parsed.hour,
    minute: parsed.minute
  };
}

function parseRuntimeClockValue(value, appSettings = {}) {
  const parsed = parseRuntimeClockParts(value);
  if (!parsed) {
    return {
      valid: false,
      normalized24h: null,
      display12h: null,
      hour24: null,
      minute: null
    };
  }

  const normalized24h = `${String(parsed.hour24).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  const display12h = formatRuntimeClockForAdmin(normalized24h, appSettings);

  return {
    valid: true,
    normalized24h,
    display12h,
    hour24: parsed.hour24,
    minute: parsed.minute
  };
}

function formatRuntimeClockForAdmin(value, appSettings = {}) {
  const parsed = parseRuntimeClockParts(String(value || "").trim().replace(/\s+/g, " "));
  if (!parsed) {
    return "12:00 AM";
  }

  const timing = resolveAppTimingSettings(appSettings);
  const normalized24h = `${String(parsed.hour24).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;

  if (timing.uiTimeFormat === "24h") {
    return normalized24h;
  }

  return format24HourTo12Hour(normalized24h, timing.timezone);
}

function buildRuntimeWindowFromClockTimes(startValue, endValue, appSettings = {}) {
  const start = parseRuntimeClockValue(startValue, appSettings);
  const end = parseRuntimeClockValue(endValue, appSettings);
  if (!start.valid || !end.valid) {
    return null;
  }

  return buildRuntimeWindow(start.normalized24h, end.normalized24h);
}

function getRuntimeWindowClockRange(windowValue, appSettings = {}) {
  const resolved = resolveRuntimeWindowConfig({
    runtimeWindow: windowValue || DEFAULT_RUNTIME_WINDOW
  });
  const window = resolved.windowParts;
  return {
    start24h: window.runtimeStart || DEFAULT_RUNTIME_START,
    end24h: window.runtimeEnd || DEFAULT_RUNTIME_END,
    start12h: formatRuntimeClockForAdmin(window.runtimeStart || DEFAULT_RUNTIME_START, appSettings),
    end12h: formatRuntimeClockForAdmin(window.runtimeEnd || DEFAULT_RUNTIME_END, appSettings)
  };
}

function normalizeTimingConfig(account = {}, appSettings = {}) {
  const timing = resolveAppTimingSettings(appSettings);
  const runtimeConfig = resolveRuntimeWindowConfig(account);
  const baseIntervalMinutes = clamp(
    toNumber(account.baseIntervalMinutes ?? account.baseInterval, 30),
    1,
    1440
  );
  const randomMinMinutes = Math.max(0, toNumber(account.randomMinMinutes ?? account.randomMin, 0));
  const randomMaxMinutes = Math.max(
    randomMinMinutes,
    toNumber(account.randomMaxMinutes ?? account.randomMax, randomMinMinutes)
  );
  const maxDailyRuntimeHours = clamp(
    toNumber(account.maxDailyRuntimeHours ?? account.maxDailyRuntime, 8),
    Number.EPSILON,
    24
  );

  return {
    ...timing,
    timezone: normalizeTimezone(timing.timezone),
    baseIntervalMinutes,
    randomMinMinutes,
    randomMaxMinutes,
    runtimeStart: runtimeConfig.runtimeStart,
    runtimeEnd: runtimeConfig.runtimeEnd,
    runtimeWindow: runtimeConfig.runtimeWindow,
    runtimeWindowParts: runtimeConfig.windowParts,
    maxDailyRuntimeHours,
    maxDailyRuntimeMs: roundToMs(maxDailyRuntimeHours * 60 * 60 * 1000)
  };
}

function getBangladeshDayKey(value, timezone = DEFAULT_TIMEZONE) {
  return toDateTime(value, timezone).toFormat("yyyy-LL-dd");
}

function isWithinRuntimeWindowAt(value, windowValue, timezone = DEFAULT_TIMEZONE) {
  const window = parseRuntimeWindow(windowValue);
  return isInsideRuntimeWindow(
    value,
    window.runtimeStart || DEFAULT_RUNTIME_START,
    window.runtimeEnd || DEFAULT_RUNTIME_END,
    timezone
  );
}

function getNextRuntimeWindowOpen(value, windowValue, timezone = DEFAULT_TIMEZONE) {
  const window = parseRuntimeWindow(windowValue);
  return getNextRuntimeStart(
    value,
    window.runtimeStart || DEFAULT_RUNTIME_START,
    window.runtimeEnd || DEFAULT_RUNTIME_END,
    timezone
  );
}

function calculateSelectedRandomDelayMinutes(randomMinMinutes, randomMaxMinutes, randomValue = Math.random()) {
  const safeMin = Math.max(0, toNumber(randomMinMinutes, 0));
  const safeMax = Math.max(safeMin, toNumber(randomMaxMinutes, safeMin));
  const normalizedRandom = clamp(toNumber(randomValue, Math.random()), 0, 1);
  const range = safeMax - safeMin;
  return safeMin + range * normalizedRandom;
}

function calculateEffectiveDelayMs(baseIntervalMinutes, randomMinMinutes, randomMaxMinutes, randomValue = Math.random()) {
  const safeBase = clamp(toNumber(baseIntervalMinutes, 30), 1, 1440);
  const selectedRandomDelayMinutes = calculateSelectedRandomDelayMinutes(
    randomMinMinutes,
    randomMaxMinutes,
    randomValue
  );
  const effectiveDelayMinutes = safeBase + selectedRandomDelayMinutes;

  return {
    selectedRandomDelayMinutes,
    effectiveDelayMinutes,
    effectiveDelayMs: roundToMs(effectiveDelayMinutes * 60 * 1000)
  };
}

function normalizeDailyRuntimeState(workerState = {}, nowValue, timezone = DEFAULT_TIMEZONE) {
  const now = toDateTime(nowValue, timezone);
  const currentDayKey = getBangladeshDayKey(now, timezone);
  const storedDayKey = String(workerState.dailyRuntimeDayKey || "").trim();
  const storedUsedMs = roundToMs(workerState.dailyRuntimeUsedMs);

  if (storedDayKey && storedDayKey === currentDayKey) {
    return {
      dayKey: currentDayKey,
      usedMs: storedUsedMs,
      resetApplied: false
    };
  }

  return {
    dayKey: currentDayKey,
    usedMs: 0,
    resetApplied: Boolean(storedDayKey && storedDayKey !== currentDayKey)
  };
}

function buildDailyRuntimeStatePatch(workerState = {}, nowValue, timezone = DEFAULT_TIMEZONE, additionalRuntimeMs = 0) {
  const normalized = normalizeDailyRuntimeState(workerState, nowValue, timezone);
  return {
    dailyRuntimeDayKey: normalized.dayKey,
    dailyRuntimeUsedMs: roundToMs(normalized.usedMs + additionalRuntimeMs),
    resetApplied: normalized.resetApplied
  };
}

function evaluateRuntimeAvailability({
  account = {},
  appSettings = {},
  now = new Date(),
  workerState = {}
} = {}) {
  const timing = normalizeTimingConfig(account, appSettings);
  const nowBdt = toDateTime(now, timing.timezone);
  const dailyRuntime = normalizeDailyRuntimeState(workerState, nowBdt, timing.timezone);
  const insideRuntimeWindow = isWithinRuntimeWindowAt(
    nowBdt,
    timing.runtimeWindow,
    timing.timezone
  );
  const dailyRuntimeCapReached = dailyRuntime.usedMs >= timing.maxDailyRuntimeMs;
  let nextAllowedStart = nowBdt;
  let reason = "within_runtime_window";

  if (!insideRuntimeWindow) {
    reason = "outside_runtime_window";
    nextAllowedStart = getNextRuntimeWindowOpen(
      nowBdt,
      timing.runtimeWindow,
      timing.timezone
    );
  } else if (dailyRuntimeCapReached) {
    reason = "daily_runtime_cap_reached";
    nextAllowedStart = getNextRuntimeWindowOpen(
      nowBdt.plus({ days: 1 }).startOf("day"),
      timing.runtimeWindow,
      timing.timezone
    );
  }

  return {
    timezone: timing.timezone,
    timezoneLabel: timing.timezoneLabel,
    uiTimeFormat: timing.uiTimeFormat,
    runtimeStart: timing.runtimeStart,
    runtimeEnd: timing.runtimeEnd,
    runtimeWindow: timing.runtimeWindow,
    nowUtcIso: nowBdt.toUTC().toISO(),
    nowBdtIso: nowBdt.toISO(),
    insideRuntimeWindow,
    dailyRuntimeDayKey: dailyRuntime.dayKey,
    dailyRuntimeUsedMs: dailyRuntime.usedMs,
    maxDailyRuntimeMs: timing.maxDailyRuntimeMs,
    maxDailyRuntimeHours: timing.maxDailyRuntimeHours,
    dailyRuntimeCapReached,
    allowedNow: insideRuntimeWindow && !dailyRuntimeCapReached,
    reason,
    nextAllowedStartIso: nextAllowedStart.toUTC().toISO(),
    nextAllowedStart: nextAllowedStart.toUTC().toJSDate()
  };
}

function computeNextRunSchedule({
  account = {},
  appSettings = {},
  now = new Date(),
  anchorAt,
  workerState = {},
  additionalRuntimeMs = 0,
  randomValue = Math.random(),
  overrideDelayMs
} = {}) {
  const timing = normalizeTimingConfig(account, appSettings);
  const nowBdt = toDateTime(now, timing.timezone);
  const nowUtc = nowBdt.toUTC();
  const rawAnchor = anchorAt || account.lastBumpAt || now;
  const anchorBdt = toDateTime(rawAnchor, timing.timezone);
  const dailyRuntime = normalizeDailyRuntimeState(workerState, nowBdt, timing.timezone);
  const forcedDelayMs = Number(overrideDelayMs);
  const overrideDelayActive = Number.isFinite(forcedDelayMs) && forcedDelayMs > 0;
  const delay =
    overrideDelayActive
      ? {
          selectedRandomDelayMinutes: 0,
          effectiveDelayMinutes: forcedDelayMs / 60000,
          effectiveDelayMs: roundToMs(forcedDelayMs)
        }
      : calculateEffectiveDelayMs(
          timing.baseIntervalMinutes,
          timing.randomMinMinutes,
          timing.randomMaxMinutes,
          randomValue
        );
  const effectiveAnchorBdt =
    overrideDelayActive && anchorBdt.toMillis() < nowBdt.toMillis()
      ? nowBdt
      : anchorBdt;
  const rawNextRunAtBdt = effectiveAnchorBdt.plus({ milliseconds: delay.effectiveDelayMs });
  const projectedRuntimeUsedMs = roundToMs(dailyRuntime.usedMs + additionalRuntimeMs);
  const dailyRuntimeCapReached = projectedRuntimeUsedMs >= timing.maxDailyRuntimeMs;

  let decision = "schedule_now";
  let reason = "within_runtime_window";
  let adjustedNextRunAtBdt = rawNextRunAtBdt;

  if (dailyRuntimeCapReached) {
    decision = "blocked_by_daily_runtime_cap";
    reason = "daily_runtime_cap_reached";
    adjustedNextRunAtBdt = getNextRuntimeWindowOpen(
      nowBdt.plus({ days: 1 }).startOf("day"),
      timing.runtimeWindow,
      timing.timezone
    );
  } else if (!isWithinRuntimeWindowAt(rawNextRunAtBdt, timing.runtimeWindow, timing.timezone)) {
    decision = "wait_until_next_valid_window";
    reason = "outside_runtime_window";
    adjustedNextRunAtBdt = getNextRuntimeWindowOpen(
      rawNextRunAtBdt,
      timing.runtimeWindow,
      timing.timezone
    );
  }

  if (!dailyRuntimeCapReached && adjustedNextRunAtBdt.toMillis() <= nowBdt.toMillis()) {
    const catchupAtBdt = nowBdt.plus({ seconds: 1 });
    if (isWithinRuntimeWindowAt(catchupAtBdt, timing.runtimeWindow, timing.timezone)) {
      decision = "schedule_now";
      reason = "overdue_schedule_catchup";
      adjustedNextRunAtBdt = catchupAtBdt;
    } else {
      decision = "wait_until_next_valid_window";
      reason = "outside_runtime_window";
      adjustedNextRunAtBdt = getNextRuntimeWindowOpen(
        catchupAtBdt,
        timing.runtimeWindow,
        timing.timezone
      );
    }
  }

  const nextRunAtUtc = adjustedNextRunAtBdt.toUTC();
  const nextDelayMs = roundToMs(nextRunAtUtc.toMillis() - nowUtc.toMillis());

  return {
    timezone: timing.timezone,
    timezoneLabel: timing.timezoneLabel,
    uiTimeFormat: timing.uiTimeFormat,
    runtimeStart: timing.runtimeStart,
    runtimeEnd: timing.runtimeEnd,
    runtimeWindow: timing.runtimeWindow,
    nowUtcIso: nowUtc.toISO(),
    nowBdtIso: nowBdt.toISO(),
    anchorAtIso: effectiveAnchorBdt.toUTC().toISO(),
    lastBumpAtIso: account.lastBumpAt ? toIso(account.lastBumpAt, timing.timezone) : null,
    baseIntervalMinutes: timing.baseIntervalMinutes,
    randomMinMinutes: timing.randomMinMinutes,
    randomMaxMinutes: timing.randomMaxMinutes,
    selectedRandomDelayMinutes: delay.selectedRandomDelayMinutes,
    effectiveDelayMinutes: delay.effectiveDelayMinutes,
    rawNextRunAtIso: rawNextRunAtBdt.toUTC().toISO(),
    adjustedNextRunAtIso: nextRunAtUtc.toISO(),
    nextRunAt: nextRunAtUtc.toJSDate(),
    nextDelayMs,
    decision,
    reason,
    dailyRuntimeDayKey: dailyRuntime.dayKey,
    dailyRuntimeUsedMs: projectedRuntimeUsedMs,
    maxDailyRuntimeMs: timing.maxDailyRuntimeMs,
    maxDailyRuntimeHours: timing.maxDailyRuntimeHours,
    runtimeWindowAdjusted: decision === "wait_until_next_valid_window",
    dailyRuntimeCapReached
  };
}

function buildScheduleDecisionLogPayload(schedule = {}) {
  return {
    currentUtcTimestamp: schedule.nowUtcIso || null,
    currentBdtTimestamp: schedule.nowBdtIso || null,
    lastBumpAt: schedule.lastBumpAtIso || null,
    anchorAt: schedule.anchorAtIso || null,
    baseIntervalMinutes: schedule.baseIntervalMinutes || 0,
    randomMinMinutes: schedule.randomMinMinutes || 0,
    randomMaxMinutes: schedule.randomMaxMinutes || 0,
    selectedRandomDelayMinutes: schedule.selectedRandomDelayMinutes || 0,
    rawNextRunAt: schedule.rawNextRunAtIso || null,
    adjustedNextRunAt: schedule.adjustedNextRunAtIso || null,
    runtimeStart: schedule.runtimeStart || null,
    runtimeEnd: schedule.runtimeEnd || null,
    dailyRuntimeUsedMs: schedule.dailyRuntimeUsedMs || 0,
    maxDailyRuntimeMs: schedule.maxDailyRuntimeMs || 0,
    finalDecision: schedule.decision || "",
    reason: schedule.reason || "",
    timezone: schedule.timezone || DEFAULT_TIMEZONE,
    timezoneLabel: schedule.timezoneLabel || DEFAULT_TIMEZONE_LABEL
  };
}

module.exports = {
  DEFAULT_RUNTIME_WINDOW,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_LABEL,
  DEFAULT_UI_TIME_FORMAT,
  QUICK_BUMP_PRESETS,
  RUNTIME_CLOCK_PATTERN_12H,
  RUNTIME_CLOCK_PATTERN_24H,
  RUNTIME_WINDOW_PATTERN,
  resolveAppTimingSettings,
  normalizeTimingConfig,
  parseRuntimeWindow,
  parseRuntimeClockValue,
  toDateTime,
  toIso,
  formatDateTimeForAdmin,
  formatRuntimeClockForAdmin,
  formatRuntimeWindowForAdmin,
  buildRuntimeWindowFromClockTimes,
  getRuntimeWindowClockRange,
  getBangladeshDayKey,
  isWithinRuntimeWindowAt,
  getNextRuntimeWindowOpen,
  calculateSelectedRandomDelayMinutes,
  calculateEffectiveDelayMs,
  normalizeDailyRuntimeState,
  buildDailyRuntimeStatePatch,
  evaluateRuntimeAvailability,
  computeNextRunSchedule,
  buildScheduleDecisionLogPayload
};
