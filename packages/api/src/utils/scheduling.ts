/**
 * Pure computation helpers for scheduling, payroll, and compliance.
 * No DB access — safe to unit test.
 */

/** Convert HH:MM to minutes since midnight */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Service duration in minutes (handles overnight: end < start) */
export function serviceMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

/** Service duration in hours (handles overnight) */
export function serviceHours(startTime: string, endTime: string): number {
  return serviceMinutes(startTime, endTime) / 60;
}

/**
 * Check if two time ranges overlap (handles overnight services on the same date).
 * An overnight service (end < start) wraps past midnight. We normalize both
 * ranges into a 0-48h window and check all valid alignments.
 */
export function timesOverlap(
  aStart: string, aEnd: string,
  bStart: string, bEnd: string,
): boolean {
  const as = timeToMinutes(aStart);
  let ae = timeToMinutes(aEnd);
  const bs = timeToMinutes(bStart);
  let be = timeToMinutes(bEnd);
  if (ae <= as) ae += 24 * 60; // overnight
  if (be <= bs) be += 24 * 60; // overnight

  // Standard overlap check
  if (as < be && bs < ae) return true;

  // If one is overnight (extends past 24h), the other's early hours
  // might alias. Service the non-overnight range +24h and recheck.
  if (ae > 24 * 60 && (bs + 24 * 60) < ae && as < (be + 24 * 60)) return true;
  if (be > 24 * 60 && (as + 24 * 60) < be && bs < (ae + 24 * 60)) return true;

  return false;
}

/** Compute OT breakdown from weekly hours (Convention HCR: threshold 39h) */
export function computeOvertimeBreakdown(weeklyHours: number, threshold: number = 39) {
  const ot = Math.max(0, weeklyHours - threshold);
  return {
    overtime: ot,
    rate110: Math.min(ot, 4),         // 39-43h
    rate120: Math.min(Math.max(ot - 4, 0), 4), // 43-47h
    rate150: Math.max(ot - 8, 0),     // 47h+
  };
}

/** Get ISO day-of-week (1=Mon..7=Sun) from YYYY-MM-DD */
export function isoDayOfWeek(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00");
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** Get Monday of the week containing dateStr */
export function getMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return fmtDate(d);
}

/** Monday of the current civil week in local time */
export function getCurrentMonday(): string {
  const today = fmtDate(new Date());
  return getMonday(today);
}

/** True if the week containing dateStr starts strictly before the current week */
export function isPastWeek(dateStr: string): boolean {
  return getMonday(dateStr) < getCurrentMonday();
}

/** Generate array of YYYY-MM-DD for Mon-Sun week */
export function weekDates(mondayStr: string): string[] {
  const d = new Date(mondayStr + "T12:00:00");
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(d);
    cur.setDate(d.getDate() + i);
    dates.push(fmtDate(cur));
  }
  return dates;
}

/** Format Date to YYYY-MM-DD without timezone service */
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parse YYYY-MM-DD as UTC noon. Stable across server timezones and DST. */
export function parseDateUTC(yyyymmdd: string): Date {
  return new Date(yyyymmdd + "T12:00:00Z");
}

/** Format a UTC-anchored Date to YYYY-MM-DD using UTC methods.
 *  Pair with parseDateUTC + setUTCDate arithmetic for TZ-stable date math. */
export function fmtDateUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** ISO week number (ISO 8601) */
export function isoWeekNum(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00");
  // Find the Thursday of this week (ISO weeks are defined by their Thursday)
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  // Week 1 contains Jan 4, so find Jan 1 of that ISO year
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  // Count days between Jan 1 and the Thursday, divide by 7, round up
  const dayDiff = Math.round((thursday.getTime() - jan1.getTime()) / 86400000);
  return Math.ceil((dayDiff + 1) / 7);
}

/** ISO week-numbering year (ISO 8601). Late December can belong to next year. */
export function isoWeekYear(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00");
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  return thursday.getFullYear();
}

/** Get all civil weeks (Mon-Sun) overlapping with a month */
export function getMonthWeeks(year: number, month: number): Array<{ from: string; to: string }> {
  const firstDay = new Date(year, month, 1, 12);
  const lastDay = new Date(year, month + 1, 0, 12);
  const firstMonday = new Date(firstDay);
  const dow = firstMonday.getDay();
  firstMonday.setDate(firstMonday.getDate() - ((dow + 6) % 7));

  const weeks: Array<{ from: string; to: string }> = [];
  for (let d = new Date(firstMonday); d <= lastDay; d.setDate(d.getDate() + 7)) {
    const wFrom = fmtDate(d);
    const wSun = new Date(d);
    wSun.setDate(d.getDate() + 6);
    weeks.push({ from: wFrom, to: fmtDate(wSun) });
  }
  return weeks;
}

/** Count business days (excl Sundays) in a date range clamped to a month */
export function countDaysInRange(
  startDate: string, endDate: string,
  monthFrom: string, monthTo: string,
): number {
  let count = 0;
  const clampStart = startDate > monthFrom ? startDate : monthFrom;
  const clampEnd = endDate < monthTo ? endDate : monthTo;
  const start = new Date(clampStart + "T12:00:00");
  const end = new Date(clampEnd + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0) count++; // exclude Sundays
  }
  return count;
}

// ── Zone overlap helpers ──

type TemplateTime = { zone: string; startTime: string; endTime: string };

/**
 * Given a list of zones a worker could fill on a single day,
 * return the max number they can actually work without time overlaps
 * and without exceeding `maxHours` (default 10h — HCR daily cap).
 *
 * Uses brute-force subset enumeration (fine for ≤8 zones per day).
 */
/**
 * Returns { count, hours } for the best non-overlapping shift combination.
 * count = max shifts that fit, hours = total hours for that combination.
 */
export function maxNonOverlappingShiftsWithHours(
  availableZones: string[],
  templateTimes: TemplateTime[],
  maxHours: number = 10,
): { count: number; hours: number } {
  const zones = availableZones
    .map(z => templateTimes.find(t => t.zone === z))
    .filter((t): t is TemplateTime => !!t);

  if (zones.length === 0) return { count: 0, hours: 0 };
  if (zones.length === 1) {
    const h = serviceHours(zones[0].startTime, zones[0].endTime);
    return h <= maxHours ? { count: 1, hours: h } : { count: 0, hours: 0 };
  }

  let best = 0;
  let bestHours = 0;
  const n = zones.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset: TemplateTime[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(zones[i]);
    }
    if (subset.length <= best) continue;
    let valid = true;
    for (let i = 0; i < subset.length && valid; i++) {
      for (let j = i + 1; j < subset.length && valid; j++) {
        if (timesOverlap(subset[i].startTime, subset[i].endTime, subset[j].startTime, subset[j].endTime)) {
          valid = false;
        }
      }
    }
    if (!valid) continue;
    const totalHours = subset.reduce((s, t) => s + serviceHours(t.startTime, t.endTime), 0);
    if (totalHours > maxHours) continue;
    best = subset.length;
    bestHours = totalHours;
  }

  return { count: best, hours: bestHours };
}

export function maxNonOverlappingShifts(
  availableZones: string[],
  templateTimes: TemplateTime[],
  maxHours: number = 10,
): number {
  const zones = availableZones
    .map(z => templateTimes.find(t => t.zone === z))
    .filter((t): t is TemplateTime => !!t);

  if (zones.length === 0) return 0;
  if (zones.length === 1) {
    return serviceHours(zones[0].startTime, zones[0].endTime) <= maxHours ? 1 : 0;
  }

  let best = 0;
  // Enumerate all subsets via bitmask (max ~256 for 8 zones)
  const n = zones.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset: TemplateTime[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(zones[i]);
    }
    if (subset.length <= best) continue; // can't improve

    // Check no pair overlaps
    let valid = true;
    for (let i = 0; i < subset.length && valid; i++) {
      for (let j = i + 1; j < subset.length && valid; j++) {
        if (timesOverlap(subset[i].startTime, subset[i].endTime, subset[j].startTime, subset[j].endTime)) {
          valid = false;
        }
      }
    }
    if (!valid) continue;

    // Check total hours within cap
    const totalHours = subset.reduce((s, t) => s + serviceHours(t.startTime, t.endTime), 0);
    if (totalHours > maxHours) continue;

    best = subset.length;
  }

  return best;
}

// ── Staffing helpers (shared by autostaffing + staffing-analysis) ──

/** Map a dynamic zone to the midi/soir availability boolean.
 *  Zones starting before 16:00 → midi availability, otherwise → soir. */
export function zoneToAvailSlot(zone: string, templates: Array<{ zone: string; startTime: string }>): "midi" | "soir" {
  const tmpl = templates.find(t => t.zone === zone);
  if (!tmpl) return "midi";
  return tmpl.startTime < "14:00" ? "midi" : "soir";
}

/** Map a dynamic zone to a 3-bucket time-of-day slot (matin/midi/soir) based on startTime.
 *  Used for the simplified /my-profile preferred-schedule grid.
 *  - matin: startTime < 11:00
 *  - midi:  11:00 ≤ startTime < 17:00
 *  - soir:  startTime ≥ 17:00 */
export function zoneToTimeOfDay(zone: string, templates: Array<{ zone: string; startTime: string }>): "matin" | "midi" | "soir" {
  const tmpl = templates.find(t => t.zone === zone);
  if (!tmpl) return "midi";
  if (tmpl.startTime < "11:00") return "matin";
  if (tmpl.startTime < "17:00") return "midi";
  return "soir";
}

/** Parse open days JSON — handles both legacy array [2,3,4,5,6,7] and new map {"2":"both"} format */
export function parseOpenDays(raw: string): Record<string, "both" | "midi" | "soir"> {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    const map: Record<string, "both" | "midi" | "soir"> = {};
    for (const d of parsed) map[String(d)] = "both";
    return map;
  }
  return parsed;
}

/** Build availability lookup from raw rows: workerId → dayOfWeek → zones map */
export function buildAvailabilityMap(
  avail: Array<{ workerId: string; dayOfWeek: number; midi: boolean; soir: boolean; zones: string }>,
): Map<string, Map<number, Record<string, boolean>>> {
  const availMap = new Map<string, Map<number, Record<string, boolean>>>();
  for (const a of avail) {
    if (!availMap.has(a.workerId)) availMap.set(a.workerId, new Map());
    const parsed: Record<string, boolean> = a.zones ? JSON.parse(a.zones) : {};
    if (Object.keys(parsed).length === 0) {
      parsed["midi"] = !!a.midi;
      parsed["soir"] = !!a.soir;
    }
    availMap.get(a.workerId)!.set(a.dayOfWeek, parsed);
  }
  return availMap;
}

// ── Restriction-based availability (time-slot) ──

type Restriction = { dayOfWeek: number; startTime: string | null; endTime: string | null; effectiveFrom?: string | null; effectiveUntil?: string | null };

/** Build restriction lookup: workerId → dayOfWeek → restrictions[] */
export function buildRestrictionMap(
  rows: Array<{ workerId: string; dayOfWeek: number; startTime: string | null; endTime: string | null; effectiveFrom?: string | null; effectiveUntil?: string | null }>,
): Map<string, Map<number, Restriction[]>> {
  const map = new Map<string, Map<number, Restriction[]>>();
  for (const r of rows) {
    if (!map.has(r.workerId)) map.set(r.workerId, new Map());
    const dayMap = map.get(r.workerId)!;
    if (!dayMap.has(r.dayOfWeek)) dayMap.set(r.dayOfWeek, []);
    dayMap.get(r.dayOfWeek)!.push(r);
  }
  return map;
}

/** Check if a service time range is blocked by any restriction on that day.
 *  Returns true if available (no blocking restriction), false if blocked.
 *  `serviceDate` (YYYY-MM-DD) filters out temporary restrictions not in effect for this date. */
export function isAvailableByRestrictions(
  restrictionMap: Map<string, Map<number, Restriction[]>>,
  workerId: string,
  dow: number,
  serviceStart: string,
  serviceEnd: string,
  serviceDate?: string,
): boolean {
  const dayRestrictions = restrictionMap.get(workerId)?.get(dow);
  if (!dayRestrictions || dayRestrictions.length === 0) return true; // no restrictions = available

  for (const r of dayRestrictions) {
    // Skip temporary restrictions not in effect for this service date
    if (serviceDate) {
      if (r.effectiveFrom && r.effectiveFrom > serviceDate) continue;
      if (r.effectiveUntil && r.effectiveUntil < serviceDate) continue;
    }
    // Full day block
    if (!r.startTime || !r.endTime) return false;
    // Time-range block: check overlap with service
    if (timesOverlap(r.startTime, r.endTime, serviceStart, serviceEnd)) return false;
  }
  return true;
}

/** Check if worker is available for a zone on a day-of-week */
export function isWorkerAvailable(
  availMap: Map<string, Map<number, Record<string, boolean>>>,
  workerId: string,
  dow: number,
  zone: string,
  templates: Array<{ zone: string; startTime: string }>,
): boolean {
  const dayZones = availMap.get(workerId)?.get(dow);
  if (!dayZones) return true; // no data = available by default
  if (zone in dayZones) return !!dayZones[zone];
  return !!dayZones[zoneToAvailSlot(zone, templates)];
}

/**
 * Compute rest hours between last service end on day1 and first service start on day2.
 * Handles overnight services.
 */
export function computeRestBetweenDays(
  day1Services: Array<{ startTime: string; endTime: string }>,
  day2Services: Array<{ startTime: string; endTime: string }>,
  daysBetween: number,
): number {
  // Last service end of day1
  let lastEndMinutes = 0;
  for (const s of day1Services) {
    let endMin = timeToMinutes(s.endTime);
    if (endMin < timeToMinutes(s.startTime)) endMin += 24 * 60; // overnight
    lastEndMinutes = Math.max(lastEndMinutes, endMin);
  }

  // First service start of day2
  const firstStart = day2Services.reduce(
    (min, s) => Math.min(min, timeToMinutes(s.startTime)),
    Infinity,
  );

  const toMidnight = (24 * 60) - lastEndMinutes;
  const fromMidnight = firstStart;
  const fullDaysMinutes = Math.max(0, daysBetween - 1) * 24 * 60;
  return (toMidnight + fromMidnight + fullDaysMinutes) / 60;
}
