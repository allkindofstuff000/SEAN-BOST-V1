const test = require("node:test");
const assert = require("node:assert/strict");
const { DateTime } = require("luxon");
const {
  buildRuntimeWindowFromClockTimes,
  QUICK_BUMP_PRESETS,
  evaluateRuntimeAvailability,
  computeNextRunSchedule,
  buildDailyRuntimeStatePatch
} = require("../src/utils/timing");
const {
  format24HourTo12Hour,
  isInsideRuntimeWindow,
  getNextRuntimeStart
} = require("../src/utils/runtimeWindow");

function toBdtIso(date) {
  return DateTime.fromJSDate(date, { zone: "utc" })
    .setZone("Asia/Dhaka")
    .toISO();
}

test("standard preset schedules last bump + base interval + random delay", () => {
  const lastBumpAt = "2026-03-07T04:00:00.000Z"; // 10:00 AM BDT
  const schedule = computeNextRunSchedule({
    account: {
      ...QUICK_BUMP_PRESETS.standard,
      lastBumpAt,
      maxDailyRuntime: 8,
      runtimeWindow: "00:00-23:59"
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now: lastBumpAt,
    anchorAt: lastBumpAt,
    workerState: {},
    randomValue: 0.5
  });

  assert.equal(schedule.selectedRandomDelayMinutes, 5);
  assert.equal(toBdtIso(schedule.nextRunAt), "2026-03-07T10:35:00.000+06:00");
});

test("aggressive preset supports decimal random delay minutes", () => {
  const lastBumpAt = "2026-03-07T04:00:00.000Z"; // 10:00 AM BDT
  const schedule = computeNextRunSchedule({
    account: {
      ...QUICK_BUMP_PRESETS.aggressive,
      lastBumpAt,
      maxDailyRuntime: 8
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now: lastBumpAt,
    anchorAt: lastBumpAt,
    workerState: {},
    randomValue: 0
  });

  assert.equal(schedule.selectedRandomDelayMinutes, 0.5);
  assert.equal(toBdtIso(schedule.nextRunAt), "2026-03-07T10:15:30.000+06:00");
});

test("business hours window shifts next run to the next day opening", () => {
  const anchorAt = "2026-03-07T10:45:00.000Z"; // 4:45 PM BDT
  const schedule = computeNextRunSchedule({
    account: {
      ...QUICK_BUMP_PRESETS.business_hours,
      lastBumpAt: anchorAt,
      maxDailyRuntime: 8
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now: anchorAt,
    anchorAt,
    workerState: {},
    randomValue: 0.5
  });

  assert.equal(schedule.decision, "wait_until_next_valid_window");
  assert.equal(toBdtIso(schedule.nextRunAt), "2026-03-08T09:00:00.000+06:00");
});

test("full-day window does not adjust a normal schedule", () => {
  const lastBumpAt = "2026-03-07T04:00:00.000Z";
  const schedule = computeNextRunSchedule({
    account: {
      ...QUICK_BUMP_PRESETS.standard,
      lastBumpAt,
      maxDailyRuntime: 8,
      runtimeWindow: "00:00-23:59"
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now: lastBumpAt,
    anchorAt: lastBumpAt,
    workerState: {},
    randomValue: 0.5
  });

  assert.equal(schedule.decision, "schedule_now");
  assert.equal(toBdtIso(schedule.nextRunAt), "2026-03-07T10:35:00.000+06:00");
});

test("daily runtime cap defers the next bump until the next BDT day", () => {
  const now = "2026-03-07T12:00:00.000Z"; // 6:00 PM BDT
  const schedule = computeNextRunSchedule({
    account: {
      ...QUICK_BUMP_PRESETS.standard,
      lastBumpAt: now,
      maxDailyRuntime: 8
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now,
    anchorAt: now,
    workerState: {
      dailyRuntimeDayKey: "2026-03-07",
      dailyRuntimeUsedMs: 8 * 60 * 60 * 1000
    },
    randomValue: 0.5
  });

  assert.equal(schedule.decision, "blocked_by_daily_runtime_cap");
  assert.equal(toBdtIso(schedule.nextRunAt), "2026-03-08T00:00:00.000+06:00");
});

test("daily runtime reset uses the Bangladesh day boundary", () => {
  const patch = buildDailyRuntimeStatePatch(
    {
      dailyRuntimeDayKey: "2026-03-06",
      dailyRuntimeUsedMs: 60 * 60 * 1000
    },
    "2026-03-06T18:30:00.000Z", // 12:30 AM on 2026-03-07 in BDT
    "Asia/Dhaka",
    30 * 60 * 1000
  );

  assert.equal(patch.dailyRuntimeDayKey, "2026-03-07");
  assert.equal(patch.dailyRuntimeUsedMs, 30 * 60 * 1000);
});

test("AM/PM runtime input normalizes to the stored runtime window format", () => {
  const runtimeWindow = buildRuntimeWindowFromClockTimes("09:00 AM", "05:00 PM");
  assert.equal(runtimeWindow, "09:00-17:00");
});

test("overnight runtime windows stay active across midnight in Bangladesh time", () => {
  assert.equal(
    isInsideRuntimeWindow("2026-03-07T19:30:00.000Z", "22:00", "04:00", "Asia/Dhaka"),
    true
  ); // 1:30 AM BDT
  assert.equal(
    isInsideRuntimeWindow("2026-03-07T11:30:00.000Z", "22:00", "04:00", "Asia/Dhaka"),
    false
  ); // 5:30 PM BDT
});

test("next runtime start jumps to the overnight window opening", () => {
  const nextStart = getNextRuntimeStart(
    "2026-03-07T12:30:00.000Z", // 6:30 PM BDT
    "22:00",
    "04:00",
    "Asia/Dhaka"
  );
  assert.equal(nextStart.toUTC().toISO(), "2026-03-07T16:00:00.000Z");
});

test("runtime availability blocks starts until business hours open", () => {
  const availability = evaluateRuntimeAvailability({
    account: {
      ...QUICK_BUMP_PRESETS.business_hours,
      runtimeStart: "09:00",
      runtimeEnd: "17:00",
      timezone: "Asia/Dhaka",
      maxDailyRuntime: 8,
      maxDailyRuntimeHours: 8
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now: "2026-03-07T02:30:00.000Z", // 8:30 AM BDT
    workerState: {}
  });

  assert.equal(availability.allowedNow, false);
  assert.equal(availability.reason, "outside_runtime_window");
  assert.equal(toBdtIso(availability.nextAllowedStart), "2026-03-07T09:00:00.000+06:00");
});

test("24-hour runtime values format to 12-hour admin labels", () => {
  assert.equal(format24HourTo12Hour("21:00"), "09:00 PM");
});

test("retry scheduling never returns a next run in the past", () => {
  const now = "2026-03-08T00:41:53.330Z";
  const schedule = computeNextRunSchedule({
    account: {
      ...QUICK_BUMP_PRESETS.aggressive,
      lastBumpAt: "2026-03-08T00:01:44.566Z",
      maxDailyRuntime: 8
    },
    appSettings: {
      timezone: "Asia/Dhaka",
      timezoneLabel: "BDT (UTC+6)",
      uiTimeFormat: "12h"
    },
    now,
    anchorAt: "2026-03-08T00:01:44.566Z",
    workerState: {
      dailyRuntimeDayKey: "2026-03-08",
      dailyRuntimeUsedMs: 2741055
    },
    overrideDelayMs: 16 * 60 * 1000 + 38 * 1000
  });

  assert.equal(schedule.reason, "within_runtime_window");
  assert.ok(new Date(schedule.nextRunAt).valueOf() > new Date(now).valueOf());
  assert.equal(toBdtIso(schedule.nextRunAt), "2026-03-08T06:58:31.330+06:00");
});
