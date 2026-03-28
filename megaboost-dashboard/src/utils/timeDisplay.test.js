import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeWindowFromClockTimes,
  formatDateTimeBDT,
  format24HourTo12Hour,
  getRuntimeWindowClockRange,
  getTimePickerParts,
  formatRuntimeWindowBDT,
  formatTimeBDT
} from "./timeDisplay.js";

test("timestamps render in 12-hour BDT format with a BDT suffix", () => {
  const formatted = formatDateTimeBDT("2026-02-27T16:35:42.000Z");
  assert.equal(formatted, "02/27/2026, 10:35:42 PM BDT");
});

test("time-only rendering uses 12-hour BDT format", () => {
  const formatted = formatTimeBDT("2026-03-07T03:00:00.000Z");
  assert.equal(formatted, "09:00:00 AM BDT");
});

test("runtime windows render as Bangladesh 12-hour ranges", () => {
  const formatted = formatRuntimeWindowBDT("09:00-17:00");
  assert.equal(formatted, "09:00 AM - 05:00 PM");
});

test("AM/PM run window inputs normalize to runtime-window storage", () => {
  const runtimeWindow = buildRuntimeWindowFromClockTimes("09:00 AM", "05:00 PM");
  assert.equal(runtimeWindow, "09:00-17:00");
});

test("stored runtime windows hydrate back to AM/PM run times", () => {
  const range = getRuntimeWindowClockRange("00:00-23:59");
  assert.deepEqual(range, {
    start24h: "00:00",
    end24h: "23:59",
    start: "12:00 AM",
    end: "11:59 PM"
  });
});

test("24-hour runtime values render to AM/PM picker labels", () => {
  assert.equal(format24HourTo12Hour("21:00"), "09:00 PM");
});

test("picker parts hydrate from stored 24-hour times", () => {
  assert.deepEqual(getTimePickerParts("21:30"), {
    hour: "09",
    minute: "30",
    period: "PM",
    displayValue: "09:30 PM"
  });
});
