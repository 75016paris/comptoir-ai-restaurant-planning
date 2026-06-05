import { db } from "../db/connection.js";
import { publishedWeeks } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { getMonday, isPastWeek } from "./scheduling.js";

/**
 * A week is locked when it's both in `published_weeks` and in the past
 * (Monday < current Monday). Past + published is payroll-committed and must
 * not change silently; admins can override with `?force=true` which writes an
 * explicit audit-log marker.
 */
export function isWeekLocked(restaurantId: string, dateStr: string): boolean {
  if (!isPastWeek(dateStr)) return false;
  const monday = getMonday(dateStr);
  const row = db.select({ id: publishedWeeks.id })
    .from(publishedWeeks)
    .where(and(
      eq(publishedWeeks.restaurantId, restaurantId),
      eq(publishedWeeks.weekDate, monday),
    ))
    .get();
  return !!row;
}

export const WEEK_LOCKED_ERROR = "Semaine verrouillée (publiée + passée). Utilisez l'option Déverrouiller pour corriger.";
