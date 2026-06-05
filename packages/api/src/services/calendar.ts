/**
 * Calendar service — fetches French public holidays (jours fériés) and school vacations
 * from government APIs. Zone detection from postal code / department.
 */

import { db } from "../db/connection.js";
import { calendarEvents, restaurants } from "../db/schema.js";
import { eq, and, gte, lte, sql, or } from "drizzle-orm";

// ── Zone mapping ──

// School vacation zones (académies → A/B/C)
// Source: https://www.education.gouv.fr/calendrier-scolaire
const DEPT_TO_SCHOOL_ZONE: Record<string, "A" | "B" | "C"> = {};

// Zone A: Besançon, Bordeaux, Clermont-Ferrand, Dijon, Grenoble, Limoges, Lyon, Poitiers
for (const d of [
  "01", "03", "07", "15", "16", "17", "19", "21", "23", "24", "25",
  "26", "33", "38", "39", "40", "42", "43", "46", "47", "58", "63",
  "64", "69", "70", "71", "73", "74", "79", "86", "87", "89", "90",
]) DEPT_TO_SCHOOL_ZONE[d] = "A";

// Zone B: Aix-Marseille, Amiens, Caen/Normandie, Lille, Nancy-Metz, Nantes, Nice,
//         Orléans-Tours, Reims, Rennes, Rouen, Strasbourg
for (const d of [
  "02", "04", "05", "06", "08", "10", "13", "14", "18", "22", "27",
  "28", "29", "35", "36", "37", "41", "44", "45", "49", "50", "51",
  "52", "53", "54", "55", "56", "57", "59", "60", "61", "62", "67",
  "68", "72", "76", "80", "83", "84", "85",
]) DEPT_TO_SCHOOL_ZONE[d] = "B";

// Zone C: Créteil, Montpellier, Paris, Toulouse, Versailles
for (const d of [
  "09", "11", "12", "30", "31", "32", "34", "48", "65", "66", "75",
  "77", "78", "81", "82", "91", "92", "93", "94", "95",
]) DEPT_TO_SCHOOL_ZONE[d] = "C";

// Corsica
DEPT_TO_SCHOOL_ZONE["2A"] = "B";
DEPT_TO_SCHOOL_ZONE["2B"] = "B";

// DOM-TOM: not zoned for metropolitan school vacations
// They have their own calendars — default to closest zone
for (const d of ["971", "972", "973", "974", "976"]) DEPT_TO_SCHOOL_ZONE[d] = "A";

// Alsace-Moselle: extra public holidays (Good Friday + St Stephen's Day)
const ALSACE_MOSELLE_DEPTS = new Set(["57", "67", "68"]);

export type SchoolZone = "A" | "B" | "C";
export type HolidayZone = "metropole" | "alsace-moselle";

/** Extract department code from a French postal code (first 2 or 3 digits) */
export function postalCodeToDept(postalCode: string): string | null {
  const clean = postalCode.replace(/\s/g, "");
  if (clean.length < 5) return null;
  // Corsica: 20xxx → 2A or 2B
  if (clean.startsWith("20")) {
    const num = parseInt(clean.substring(0, 5));
    return num < 20200 ? "2A" : "2B";
  }
  // DOM-TOM: 3-digit prefix
  if (clean.startsWith("97")) return clean.substring(0, 3);
  return clean.substring(0, 2);
}

/** Extract postal code from a French address string */
export function extractPostalCode(address: string): string | null {
  const match = address.match(/\b((?:97[1-6]|[0-9]{2})\d{2,3})\b/);
  return match ? match[1] : null;
}

/** Detect zones from a postal code string */
export function detectZonesFromPostcode(postalCode: string): { schoolZone: SchoolZone; holidayZone: HolidayZone } | null {
  const dept = postalCodeToDept(postalCode);
  if (!dept) return null;
  const schoolZone = DEPT_TO_SCHOOL_ZONE[dept];
  if (!schoolZone) return null;
  const holidayZone: HolidayZone = ALSACE_MOSELLE_DEPTS.has(dept) ? "alsace-moselle" : "metropole";
  return { schoolZone, holidayZone };
}

/** Detect zones from an address (extracts postal code first) */
export function detectZones(address: string): { schoolZone: SchoolZone; holidayZone: HolidayZone } | null {
  const postalCode = extractPostalCode(address);
  if (!postalCode) return null;
  return detectZonesFromPostcode(postalCode);
}

// ── Government API fetchers ──

/** Fetch public holidays from calendrier.api.gouv.fr */
export async function fetchPublicHolidays(year: number, zone: HolidayZone = "metropole"): Promise<Array<{ date: string; name: string }>> {
  const url = `https://calendrier.api.gouv.fr/jours-feries/${zone}/${year}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as Record<string, string>;
    return Object.entries(data).map(([date, name]) => ({ date, name }));
  } catch {
    return [];
  }
}

/** Fetch school vacations from data.education.gouv.fr */
export async function fetchSchoolVacations(
  zone: SchoolZone,
  year: number,
): Promise<Array<{ startDate: string; endDate: string; name: string }>> {
  // The dataset uses school year format (2025-2026)
  const schoolYears = [`${year - 1}-${year}`, `${year}-${year + 1}`];
  const results: Array<{ startDate: string; endDate: string; name: string }> = [];

  for (const schoolYear of schoolYears) {
    const params = new URLSearchParams({
      where: `zones="Zone ${zone}" AND annee_scolaire="${schoolYear}"`,
      limit: "50",
      order_by: "start_date",
    });
    const url = `https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records?${params}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.results || []) {
        if (!r.start_date || !r.end_date || !r.description) continue;
        const startDate = r.start_date.substring(0, 10);
        const endDate = r.end_date.substring(0, 10);
        // Only include if the vacation overlaps with the requested year
        if (endDate >= `${year}-01-01` && startDate <= `${year}-12-31`) {
          results.push({ startDate, endDate, name: r.description });
        }
      }
    } catch {
      continue;
    }
  }

  // Deduplicate by name+start
  const seen = new Set<string>();
  return results.filter(r => {
    const key = `${r.name}_${r.startDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── DB operations ──

/** Refresh calendar events for a restaurant (public holidays + school vacations) */
export async function refreshCalendarEvents(
  restaurantId: string,
): Promise<{ holidays: number; vacations: number; errors: string[] }> {
  const [restaurant] = db.select({
    schoolZone: restaurants.schoolZone,
    holidayZone: restaurants.holidayZone,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();

  if (!restaurant?.schoolZone || !restaurant?.holidayZone) {
    return { holidays: 0, vacations: 0, errors: ["Zones non détectées — vérifiez l'adresse du restaurant"] };
  }

  const now = new Date();
  const year = now.getFullYear();
  const errors: string[] = [];
  let holidayCount = 0;
  let vacationCount = 0;

  // Fetch for current year and next year
  for (const y of [year, year + 1]) {
    // Public holidays
    const holidays = await fetchPublicHolidays(y, restaurant.holidayZone as HolidayZone);
    if (holidays.length === 0) {
      errors.push(`Impossible de récupérer les jours fériés ${y}`);
    } else {
      // Delete existing holidays for this year, then insert
      db.transaction((tx) => {
        tx.delete(calendarEvents)
          .where(and(
            eq(calendarEvents.restaurantId, restaurantId),
            eq(calendarEvents.type, "public_holiday"),
            eq(calendarEvents.year, y),
          )).run();
        for (const h of holidays) {
          tx.insert(calendarEvents).values({
            restaurantId,
            type: "public_holiday",
            date: h.date,
            name: h.name,
            zone: restaurant.holidayZone!,
            year: y,
          }).run();
        }
      });
      holidayCount += holidays.length;
    }

    // School vacations
    const vacations = await fetchSchoolVacations(restaurant.schoolZone as SchoolZone, y);
    if (vacations.length === 0) {
      errors.push(`Impossible de récupérer les vacances scolaires ${y}`);
    } else {
      db.transaction((tx) => {
        tx.delete(calendarEvents)
          .where(and(
            eq(calendarEvents.restaurantId, restaurantId),
            eq(calendarEvents.type, "school_vacation"),
            eq(calendarEvents.year, y),
          )).run();
        for (const v of vacations) {
          tx.insert(calendarEvents).values({
            restaurantId,
            type: "school_vacation",
            date: v.startDate,
            endDate: v.endDate,
            name: v.name,
            zone: restaurant.schoolZone!,
            year: y,
          }).run();
        }
      });
      vacationCount += vacations.length;
    }
  }

  return { holidays: holidayCount, vacations: vacationCount, errors };
}

/**
 * Get all calendar events that overlap a date range (handles vacation spans).
 * A vacation from March 1–15 should appear when querying March 10–20.
 */
export function getCalendarEventsInRange(
  restaurantId: string,
  from: string,
  to: string,
): Array<{ type: string; date: string; endDate: string | null; name: string }> {
  return db.select({
    type: calendarEvents.type,
    date: calendarEvents.date,
    endDate: calendarEvents.endDate,
    name: calendarEvents.name,
  }).from(calendarEvents)
    .where(and(
      eq(calendarEvents.restaurantId, restaurantId),
      or(
        // Public holidays: single date within range
        and(sql`${calendarEvents.endDate} IS NULL`, gte(calendarEvents.date, from), lte(calendarEvents.date, to)),
        // School vacations: date range overlaps query range
        and(sql`${calendarEvents.endDate} IS NOT NULL`, lte(calendarEvents.date, to), gte(calendarEvents.endDate, from)),
      ),
    ))
    .orderBy(calendarEvents.date)
    .all();
}
