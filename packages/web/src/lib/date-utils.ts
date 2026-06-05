// Locale-aware date formatting utilities.
// Reads the current language from i18next at call time, so flipping locale
// at runtime updates date display without rebuilding the cache.

import i18n from "@/i18n";

function locale(): string {
  return i18n.language || "fr";
}

/** Parse "YYYY-MM-DD" string to Date (noon to avoid TZ issues) */
export function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

// ── Cached Intl formatters per locale × options ────────────────────────────
// Intl.DateTimeFormat construction is expensive; cache by locale+key.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function getFmt(opts: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const lng = locale();
  const ck = `${lng}|${key}`;
  let f = fmtCache.get(ck);
  if (!f) {
    f = new Intl.DateTimeFormat(lng, opts);
    fmtCache.set(ck, f);
  }
  return f;
}

// Reset cache when locale changes so date strings re-render in the new language.
i18n.on("languageChanged", () => fmtCache.clear());

/** "2 avril" / "April 2" — day + full month */
export function fmtDateFR(dateStr: string): string {
  return getFmt({ day: "numeric", month: "long" }, "dM").format(parseDate(dateStr));
}

/** "2 avr." / "Apr 2" — day + short month (compact) */
export function fmtDateShort(dateStr: string): string {
  return getFmt({ day: "numeric", month: "short" }, "dMs").format(parseDate(dateStr));
}

/** "mar. 2 avr." / "Tue, Apr 2" — short weekday + day + short month */
export function fmtDateMed(dateStr: string): string {
  return getFmt({ weekday: "short", day: "numeric", month: "short" }, "wdMs").format(parseDate(dateStr));
}

/** "mardi 2 avril" / "Tuesday, April 2" — full weekday + day + full month */
export function fmtDateLong(dateStr: string): string {
  return getFmt({ weekday: "long", day: "numeric", month: "long" }, "WDM").format(parseDate(dateStr));
}

/** "2 avr. 2026" / "Apr 2, 2026" — day + short month + year */
export function fmtDateYear(dateStr: string): string {
  return getFmt({ day: "numeric", month: "short", year: "numeric" }, "dMsY").format(parseDate(dateStr));
}

/** "02/04/26" / "04/02/26" — short numeric date */
export function fmtDateSlash(dateStr: string): string {
  return getFmt({ day: "2-digit", month: "2-digit", year: "2-digit" }, "slash").format(parseDate(dateStr));
}

/** "2 avr. — 8 avr." — short date range */
export function fmtDateRange(fromStr: string, toStr: string): string {
  return `${fmtDateShort(fromStr)} — ${fmtDateShort(toStr)}`;
}

/** "2 avril — 8 avril" — full date range */
export function fmtDateRangeLong(fromStr: string, toStr: string): string {
  return `${fmtDateFR(fromStr)} — ${fmtDateFR(toStr)}`;
}

/** "avril 2026" / "April 2026" — full month + year (for month headers) */
export function fmtMonthYear(date: Date): string {
  return getFmt({ month: "long", year: "numeric" }, "MY").format(date);
}

/** "Avril 2026" — capitalized month + year (capitalize first char) */
export function fmtMonthYearCap(date: Date): string {
  const s = fmtMonthYear(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Get full localized day name from Date object */
export function jourSemaine(date: Date): string {
  return getFmt({ weekday: "long" }, "W").format(date);
}

/** Get short localized day name from Date object */
export function jourSemaineCourt(date: Date): string {
  return getFmt({ weekday: "short" }, "w").format(date);
}

/** "14:32" / "2:32 PM" — locale-aware short time */
export function fmtTime(date: Date): string {
  return getFmt({ hour: "2-digit", minute: "2-digit" }, "hm").format(date);
}

/** Format "YYYY-MM-DD" from Date (for API calls, not display) */
export function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Backwards-compatible array exports ──────────────────────────────────────
// JOURS[i] / MOIS[i] / etc. — kept as Proxy that reads the current locale on
// each access so existing `JOURS[d.getDay()]` callers don't need to change.

function buildDays(format: "long" | "short"): string[] {
  // Sunday = 0. Jan 7 2024 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2024, 0, 7 + i, 12);
    return new Intl.DateTimeFormat(locale(), { weekday: format }).format(d);
  });
}

function buildMonths(format: "long" | "short"): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(2024, i, 1, 12);
    return new Intl.DateTimeFormat(locale(), { month: format }).format(d);
  });
}

function arrayProxy(builder: () => string[]): string[] {
  return new Proxy([] as string[], {
    get(_, prop) {
      if (prop === "length") return builder().length;
      if (typeof prop === "string" || typeof prop === "number") {
        const i = Number(prop);
        if (Number.isFinite(i)) return builder()[i];
      }
      return undefined;
    },
  });
}

export const JOURS: string[] = arrayProxy(() => buildDays("long"));
export const JOURS_COURTS: string[] = arrayProxy(() => buildDays("short"));
export const MOIS: string[] = arrayProxy(() => buildMonths("long"));
export const MOIS_COURTS: string[] = arrayProxy(() => buildMonths("short"));
