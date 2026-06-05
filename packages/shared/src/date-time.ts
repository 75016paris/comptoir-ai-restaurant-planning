export const DEFAULT_RESTAURANT_TIMEZONE = "Europe/Paris";

export function parseServerTimestamp(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized);
}

function safeTimeZone(timeZone: string | null | undefined): string {
  return timeZone || DEFAULT_RESTAURANT_TIMEZONE;
}

function formatParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

export function zonedDateParts(date: Date = new Date(), timeZone?: string | null) {
  try {
    return formatParts(date, safeTimeZone(timeZone));
  } catch {
    return formatParts(date, DEFAULT_RESTAURANT_TIMEZONE);
  }
}

export function todayInTimeZone(timeZone?: string | null, now: Date = new Date()): string {
  const p = zonedDateParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function calendarDaysBetween(fromDate: string, toDate: string): number {
  const [fromY, fromM, fromD] = fromDate.split("-").map(Number);
  const [toY, toM, toD] = toDate.split("-").map(Number);
  const fromUtc = Date.UTC(fromY, fromM - 1, fromD);
  const toUtc = Date.UTC(toY, toM - 1, toD);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

export function formatInstantInTimeZone(
  value: string | Date,
  locale = "fr-FR",
  timeZone?: string | null,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const parsed = value instanceof Date ? value : parseServerTimestamp(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: safeTimeZone(timeZone),
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(parsed);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: DEFAULT_RESTAURANT_TIMEZONE }).format(parsed);
  }
}

function offsetMinutesFor(instant: Date, timeZone: string): number {
  const p = zonedDateParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60000;
}

/** Convert a restaurant-local business date+time to its UTC instant. */
export function zonedDateTimeToUtc(date: string, time: string, timeZone?: string | null): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const tz = safeTimeZone(timeZone);
  const naiveUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const firstOffset = offsetMinutesFor(new Date(naiveUtcMs), tz);
  const first = new Date(naiveUtcMs - firstOffset * 60000);
  const secondOffset = offsetMinutesFor(first, tz);
  return new Date(naiveUtcMs - secondOffset * 60000);
}
