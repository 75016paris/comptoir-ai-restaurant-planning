/**
 * Per-worker day-of-week template derivation for the CP-SAT templateMatch
 * objective term. Based on the CP-SAT reference-pattern analysis and Step 2
 * équipe-stable template-match measurement from the internal decision notes.
 *
 * Queries the `services` table for each worker's confirmed (non-cancelled)
 * assignments in the trailing N weeks ending the day before `asOfDate`, and
 * returns `Map<workerId, Set<dow>>` where `dow` uses the ISO 1..7 (Mon=1,
 * Sun=7) encoding that matches `slot.dow` as produced by
 * `isoDayOfWeek()` in `utils/scheduling.ts`. Consistency matters —
 * `cpsat-solver.ts` compares the template set against `slot.dow` verbatim.
 *
 * Side-effect free (pure read). Call from the solver entry points
 * (`multi-week-solver.ts`, `autostaffing.ts`) gated by
 * `templateMatchEnabled()`. When the flag is off, callers pass `undefined`
 * so the objective term is a no-op — default production behaviour is
 * unchanged.
 */

import { db } from "../db/connection.js";
import { services } from "../db/schema.js";
import { and, eq, gte, lt, ne } from "drizzle-orm";
import { fmtDateUTC, isoDayOfWeek, parseDateUTC } from "../utils/scheduling.js";

export const DEFAULT_LOOKBACK_WEEKS = 10;

/** Row shape fetched from `services` — exposed for testing the pure transform. */
export type ServiceRow = { workerId: string; date: string };

/**
 * Pure transform: roll up service rows into per-worker dow sets. Dedup is
 * implicit via `Set`. Exposed separately from the DB-hitting wrapper so unit
 * tests can cover dow extraction + dedup without a real database.
 */
export function dowTemplatesFromRows(rows: ServiceRow[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const r of rows) {
    const dow = isoDayOfWeek(r.date);
    let set = out.get(r.workerId);
    if (!set) {
      set = new Set<number>();
      out.set(r.workerId, set);
    }
    set.add(dow);
  }
  return out;
}

/**
 * Query the last `lookbackWeeks` weeks of non-cancelled services for
 * `restaurantId` ending the day before `asOfDate`, and derive per-worker dow
 * templates. Workers without any history get no entry — the solver treats a
 * missing entry the same as an empty set (no-op for that worker).
 */
export function deriveDowTemplates(
  restaurantId: string,
  asOfDate: string,
  lookbackWeeks: number = DEFAULT_LOOKBACK_WEEKS,
): Map<string, Set<number>> {
  const start = parseDateUTC(asOfDate);
  start.setUTCDate(start.getUTCDate() - lookbackWeeks * 7);
  const startStr = fmtDateUTC(start);

  const rows = db.select({
    workerId: services.workerId,
    date: services.date,
  }).from(services)
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, startStr),
      lt(services.date, asOfDate),
      ne(services.status, "cancelled"),
    )).all();

  return dowTemplatesFromRows(rows);
}

/**
 * Env-gated rollout switch for the templateMatch objective term. Default ON
 * since 2026-04-24 (attribution sweep proved it carries ~70% of équipe-
 * stable's dowPatternStability lift). Set TEMPLATE_MATCH_ENABLED=0 to
 * disable as an emergency rollback.
 */
export function templateMatchEnabled(): boolean {
  const v = process.env.TEMPLATE_MATCH_ENABLED;
  return v !== "0" && v !== "false";
}
