const { DateTime } = require("luxon");

const DEFAULT_RUNTIME_TIMEZONE = "Asia/Dhaka";
const DEFAULT_RUNTIME_START = "00:00";
const DEFAULT_RUNTIME_END = "23:59";
const TIME_24H_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_12H_PATTERN = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AP]M)$/i;
const RUNTIME_WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeTimezone(value) {
  const candidate = String(value || "").trim() || DEFAULT_RUNTIME_TIMEZONE;
  const probe = DateTime.now().setZone(candidate);
  return probe.isValid ? candidate : DEFAULT_RUNTIME_TIMEZONE;
}

function toDateTime(value, timezone = DEFAULT_RUNTIME_TIMEZONE) {
  const zone = normalizeTimezone(timezone);

  if (DateTime.isDateTime(value)) {
    return value.setZone(zone);
  }

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

  return parsed.isValid ? parsed.setZone(zone) : DateTime.now().setZone(zone);
}

function parse24HourTime(value) {
  const raw = String(value || "").trim();
  const match = raw.match(TIME_24H_PATTERN);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  return {
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    normalized: `${pad2(hour)}:${pad2(minute)}`
  };
}

function parse12HourString(value) {
  const raw = String(value || "").trim().toUpperCase();
  const match = raw.match(TIME_12H_PATTERN);
  if (!match) {
    return null;
  }

  const normalized = parse12HourTo24Hour(match[1], match[2], match[3]);
  return normalized ? parse24HourTime(normalized) : null;
}

function parseRuntimeTime(value) {
  return parse24HourTime(value) || parse12HourString(value);
}

function parse12HourTo24Hour(hour, minute, ampm) {
  const hour12 = Number(hour);
  const minuteValue = Number(minute);
  const meridiem = String(ampm || "").trim().toUpperCase();

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

  return `${pad2(hour24)}:${pad2(minuteValue)}`;
}

function format24HourTo12Hour(time24, timezone = DEFAULT_RUNTIME_TIMEZONE) {
  const parsed = parse24HourTime(time24);
  if (!parsed) {
    return "12:00 AM";
  }

  return DateTime.fromObject(
    {
      year: 2026,
      month: 1,
      day: 1,
      hour: parsed.hour,
      minute: parsed.minute
    },
    { zone: normalizeTimezone(timezone) }
  ).toFormat("hh:mm a");
}

function buildRuntimeWindow(start, end) {
  const startTime = parseRuntimeTime(start);
  const endTime = parseRuntimeTime(end);
  if (!startTime || !endTime) {
    return null;
  }

  return `${startTime.normalized}-${endTime.normalized}`;
}

function parseRuntimeWindow(windowValue = `${DEFAULT_RUNTIME_START}-${DEFAULT_RUNTIME_END}`) {
  const raw = String(windowValue || "").trim() || `${DEFAULT_RUNTIME_START}-${DEFAULT_RUNTIME_END}`;
  const match = raw.match(RUNTIME_WINDOW_PATTERN);
  if (!match) {
    return {
      valid: false,
      runtimeStart: DEFAULT_RUNTIME_START,
      runtimeEnd: DEFAULT_RUNTIME_END,
      normalized: `${DEFAULT_RUNTIME_START}-${DEFAULT_RUNTIME_END}`,
      startMinutes: 0,
      endMinutes: 23 * 60 + 59,
      wrapsMidnight: false,
      isFullDay: true,
      startHour: 0,
      startMinute: 0,
      endHour: 23,
      endMinute: 59
    };
  }

  const start = parse24HourTime(`${match[1]}:${match[2]}`);
  const end = parse24HourTime(`${match[3]}:${match[4]}`);
  const normalized = `${start.normalized}-${end.normalized}`;
  const wrapsMidnight = start.minutesOfDay > end.minutesOfDay;
  const isFullDay =
    normalized === `${DEFAULT_RUNTIME_START}-${DEFAULT_RUNTIME_END}` ||
    start.minutesOfDay === end.minutesOfDay;

  return {
    valid: true,
    runtimeStart: start.normalized,
    runtimeEnd: end.normalized,
    normalized,
    startMinutes: start.minutesOfDay,
    endMinutes: end.minutesOfDay,
    wrapsMidnight,
    isFullDay,
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute
  };
}

function resolveRuntimeWindowConfig(source = {}) {
  const fromWindow = parseRuntimeWindow(source.runtimeWindow);
  const explicitStart =
    parseRuntimeTime(source.runtimeStart) ||
    parseRuntimeTime(source.runtimeStartTime) ||
    parseRuntimeTime(source.runFromTime);
  const explicitEnd =
    parseRuntimeTime(source.runtimeEnd) ||
    parseRuntimeTime(source.runtimeEndTime) ||
    parseRuntimeTime(source.runToTime);
  const runtimeStart = explicitStart?.normalized || fromWindow.runtimeStart || DEFAULT_RUNTIME_START;
  const runtimeEnd = explicitEnd?.normalized || fromWindow.runtimeEnd || DEFAULT_RUNTIME_END;
  const runtimeWindow = buildRuntimeWindow(runtimeStart, runtimeEnd) || fromWindow.normalized;
  const windowParts = parseRuntimeWindow(runtimeWindow);

  return {
    runtimeStart: windowParts.runtimeStart,
    runtimeEnd: windowParts.runtimeEnd,
    runtimeWindow: windowParts.normalized,
    windowParts
  };
}

function isOvernightWindow(start, end) {
  const runtimeStart = parseRuntimeTime(start);
  const runtimeEnd = parseRuntimeTime(end);
  if (!runtimeStart || !runtimeEnd) {
    return false;
  }
  return runtimeStart.minutesOfDay > runtimeEnd.minutesOfDay;
}

function isInsideRuntimeWindow(now, start, end, timezone = DEFAULT_RUNTIME_TIMEZONE) {
  const dateTime = toDateTime(now, timezone);
  const runtimeStart = parseRuntimeTime(start);
  const runtimeEnd = parseRuntimeTime(end);
  if (!runtimeStart || !runtimeEnd) {
    return true;
  }

  const currentMinutes = dateTime.hour * 60 + dateTime.minute;
  const startMinutes = runtimeStart.minutesOfDay;
  const endMinutes = runtimeEnd.minutesOfDay;

  if (
    runtimeStart.normalized === DEFAULT_RUNTIME_START &&
    runtimeEnd.normalized === DEFAULT_RUNTIME_END
  ) {
    return true;
  }

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function getNextRuntimeStart(now, start, end, timezone = DEFAULT_RUNTIME_TIMEZONE) {
  const dateTime = toDateTime(now, timezone);
  const runtimeStart = parseRuntimeTime(start) || parseRuntimeTime(DEFAULT_RUNTIME_START);
  const runtimeEnd = parseRuntimeTime(end) || parseRuntimeTime(DEFAULT_RUNTIME_END);

  if (isInsideRuntimeWindow(dateTime, runtimeStart.normalized, runtimeEnd.normalized, timezone)) {
    return dateTime;
  }

  const startToday = dateTime.startOf("day").plus({ minutes: runtimeStart.minutesOfDay });
  const overnight = isOvernightWindow(runtimeStart.normalized, runtimeEnd.normalized);
  const currentMinutes = dateTime.hour * 60 + dateTime.minute;

  if (!overnight) {
    if (currentMinutes < runtimeStart.minutesOfDay) {
      return startToday;
    }
    return startToday.plus({ days: 1 });
  }

  if (currentMinutes < runtimeEnd.minutesOfDay) {
    return dateTime;
  }

  return currentMinutes < runtimeStart.minutesOfDay ? startToday : startToday.plus({ days: 1 });
}

module.exports = {
  DEFAULT_RUNTIME_TIMEZONE,
  DEFAULT_RUNTIME_START,
  DEFAULT_RUNTIME_END,
  TIME_24H_PATTERN,
  TIME_12H_PATTERN,
  RUNTIME_WINDOW_PATTERN,
  normalizeTimezone,
  toDateTime,
  parse24HourTime,
  parseRuntimeTime,
  parse12HourTo24Hour,
  format24HourTo12Hour,
  buildRuntimeWindow,
  parseRuntimeWindow,
  resolveRuntimeWindowConfig,
  isOvernightWindow,
  isInsideRuntimeWindow,
  getNextRuntimeStart
};
