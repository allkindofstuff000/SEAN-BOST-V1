import { DateTime } from "luxon";

export const DEFAULT_TIMEZONE = "Asia/Dhaka";
export const DEFAULT_TIMEZONE_LABEL = "BDT (UTC+6)";
export const DEFAULT_UI_TIME_FORMAT = "12h";
export const DEFAULT_RUNTIME_WINDOW = "00:00-23:59";
export const RUNTIME_WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
export const RUNTIME_CLOCK_PATTERN = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AP]M)$/i;
export const TIME_PICKER_HOURS = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0")
);
export const TIME_PICKER_MINUTES = Array.from({ length: 60 }, (_, index) =>
  String(index).padStart(2, "0")
);
export const TIME_PICKER_PERIODS = ["AM", "PM"];

function normalizeTimezone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return DEFAULT_TIMEZONE;
  const probe = DateTime.now().setZone(candidate);
  return probe.isValid ? candidate : DEFAULT_TIMEZONE;
}

function normalizeTimezoneLabel(value) {
  const candidate = String(value || "").trim();
  return candidate || DEFAULT_TIMEZONE_LABEL;
}

function getShortTimezoneLabel(value) {
  return normalizeTimezoneLabel(value).split("(")[0].trim() || "BDT";
}

function normalizeUiTimeFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "24h" ? "24h" : DEFAULT_UI_TIME_FORMAT;
}

export function getTimingDisplaySettings(settings = {}) {
  return {
    timezone: normalizeTimezone(settings.timezone),
    timezoneLabel: normalizeTimezoneLabel(settings.timezoneLabel),
    uiTimeFormat: normalizeUiTimeFormat(settings.uiTimeFormat)
  };
}

function toDateTime(value, settings = {}) {
  const display = getTimingDisplaySettings(settings);
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return DateTime.fromJSDate(value, { zone: "utc" }).setZone(display.timezone);
  }

  if (typeof value === "number") {
    return DateTime.fromMillis(value, { zone: "utc" }).setZone(display.timezone);
  }

  const raw = String(value || "").trim();
  if (!raw) return null;

  let parsed = DateTime.fromISO(raw, { zone: "utc" });
  if (!parsed.isValid) {
    parsed = DateTime.fromJSDate(new Date(raw), { zone: "utc" });
  }

  return parsed.isValid ? parsed.setZone(display.timezone) : null;
}

export function formatDateTimeBDT(value, settings = {}, options = {}) {
  const display = getTimingDisplaySettings(settings);
  const dateTime = toDateTime(value, display);
  if (!dateTime) {
    return options.fallback || "-";
  }

  const includeDate = options.includeDate !== false;
  const includeSeconds = options.includeSeconds !== false;
  const includeTimezone = options.includeTimezone !== false;
  const pattern =
    display.uiTimeFormat === "24h"
      ? includeSeconds
        ? "HH:mm:ss"
        : "HH:mm"
      : includeSeconds
        ? "hh:mm:ss a"
        : "hh:mm a";
  const datePrefix = includeDate ? "MM/dd/yyyy, " : "";
  const suffix = includeTimezone ? ` ${getShortTimezoneLabel(display.timezoneLabel)}` : "";

  return `${dateTime.toFormat(`${datePrefix}${pattern}`)}${suffix}`;
}

export function formatTimeBDT(value, settings = {}, options = {}) {
  return formatDateTimeBDT(value, settings, {
    ...options,
    includeDate: false,
    includeTimezone: options.includeTimezone ?? true
  });
}

export function formatDateBDT(value, settings = {}, options = {}) {
  const display = getTimingDisplaySettings(settings);
  const dateTime = toDateTime(value, display);
  if (!dateTime) {
    return options.fallback || "-";
  }
  const suffix = options.includeTimezone ? ` ${display.timezoneLabel}` : "";
  return `${dateTime.toFormat("MM/dd/yyyy")}${suffix}`;
}

function parseRuntimeClock(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const match24h = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (match24h) {
    return {
      hour24: Number(match24h[1]),
      minute: Number(match24h[2])
    };
  }

  const match12h = raw.toUpperCase().match(RUNTIME_CLOCK_PATTERN);
  if (!match12h) {
    return null;
  }

  const hour12 = Number(match12h[1]);
  const minute = Number(match12h[2]);
  const meridiem = String(match12h[3] || "").toUpperCase();
  let hour24 = hour12 % 12;
  if (meridiem === "PM") {
    hour24 += 12;
  }

  return {
    hour24,
    minute
  };
}

export function parse12HourTo24Hour(hour, minute, period) {
  const hour12 = Number(hour);
  const minuteValue = Number(minute);
  const meridiem = String(period || "").trim().toUpperCase();

  if (
    !Number.isInteger(hour12) ||
    hour12 < 1 ||
    hour12 > 12 ||
    !Number.isInteger(minuteValue) ||
    minuteValue < 0 ||
    minuteValue > 59 ||
    (meridiem !== "AM" && meridiem !== "PM")
  ) {
    return null;
  }

  let hour24 = hour12 % 12;
  if (meridiem === "PM") {
    hour24 += 12;
  }

  return `${String(hour24).padStart(2, "0")}:${String(minuteValue).padStart(2, "0")}`;
}

export function format24HourTo12Hour(time24, settings = {}) {
  return formatRuntimeClockBDT(time24, settings);
}

export function getTimePickerParts(value, settings = {}) {
  const displayValue = format24HourTo12Hour(value || "00:00", settings);
  const match = displayValue.match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AP]M)$/i);
  if (!match) {
    return {
      hour: "12",
      minute: "00",
      period: "AM",
      displayValue: "12:00 AM"
    };
  }

  return {
    hour: String(match[1]).padStart(2, "0"),
    minute: match[2],
    period: String(match[3]).toUpperCase(),
    displayValue: `${String(match[1]).padStart(2, "0")}:${match[2]} ${String(match[3]).toUpperCase()}`
  };
}

export function buildTimePickerValue({ hour = "12", minute = "00", period = "AM" } = {}) {
  const normalized24h = parse12HourTo24Hour(hour, minute, period);
  if (!normalized24h) {
    return "12:00 AM";
  }

  return format24HourTo12Hour(normalized24h);
}

export function formatRuntimeClockBDT(value, settings = {}) {
  const display = getTimingDisplaySettings(settings);
  const parsed = parseRuntimeClock(value);
  if (!parsed) {
    return "12:00 AM";
  }

  return DateTime.fromObject(
    {
      year: 2026,
      month: 1,
      day: 1,
      hour: parsed.hour24,
      minute: parsed.minute
    },
    { zone: display.timezone }
  ).toFormat(display.uiTimeFormat === "24h" ? "HH:mm" : "hh:mm a");
}

export function buildRuntimeWindowFromClockTimes(startValue, endValue) {
  const start = parseRuntimeClock(startValue);
  const end = parseRuntimeClock(endValue);
  if (!start || !end) {
    return null;
  }

  return `${String(start.hour24).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}-${String(
    end.hour24
  ).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`;
}

export function getRuntimeWindowClockRange(windowValue, settings = {}) {
  const raw = String(windowValue || "").trim() || DEFAULT_RUNTIME_WINDOW;
  const match = raw.match(RUNTIME_WINDOW_PATTERN) || DEFAULT_RUNTIME_WINDOW.match(RUNTIME_WINDOW_PATTERN);
  const start24h = `${match[1]}:${match[2]}`;
  const end24h = `${match[3]}:${match[4]}`;

  return {
    start24h,
    end24h,
    start: formatRuntimeClockBDT(start24h, settings),
    end: formatRuntimeClockBDT(end24h, settings)
  };
}

export function formatRuntimeWindowBDT(windowValue, settings = {}) {
  const display = getTimingDisplaySettings(settings);
  const raw = String(windowValue || "").trim() || DEFAULT_RUNTIME_WINDOW;
  const match = raw.match(RUNTIME_WINDOW_PATTERN);
  if (!match) {
    return DEFAULT_RUNTIME_WINDOW;
  }

  const start = DateTime.fromObject(
    {
      year: 2026,
      month: 1,
      day: 1,
      hour: Number(match[1]),
      minute: Number(match[2])
    },
    { zone: display.timezone }
  );
  const end = DateTime.fromObject(
    {
      year: 2026,
      month: 1,
      day: 1,
      hour: Number(match[3]),
      minute: Number(match[4])
    },
    { zone: display.timezone }
  );
  const pattern = display.uiTimeFormat === "24h" ? "HH:mm" : "hh:mm a";
  return `${start.toFormat(pattern)} - ${end.toFormat(pattern)}`;
}
