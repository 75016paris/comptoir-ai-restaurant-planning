// One-shot: fill empty staffing_targets.role_breakdown with `{lowestTierSubRole: count}`
// using each restaurant's own sub-role catalog + HCR map. Idempotent — only touches rows
// where the breakdown is null/empty/{}. Run BEFORE migration 0087 (which drops the toggle).
import { db } from "../../../src/db/connection.js";
import { restaurants, staffingTargets } from "../../../src/db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { HCR_LEVELS, DEFAULT_SUBROLE_TO_HCR, type HcrLevel } from "@comptoir/shared/hcr";

const HCR_RANK = Object.fromEntries(HCR_LEVELS.map((lvl, i) => [lvl, i])) as Record<HcrLevel, number>;

function lowestTier(catalog: string[], hcrMap: Record<string, HcrLevel>, fallback: string): string {
  if (catalog.length === 0) return fallback;
  const ranked = catalog.map((sr) => ({
    sr,
    rank: HCR_RANK[(hcrMap[sr] ?? DEFAULT_SUBROLE_TO_HCR[sr]) as HcrLevel] ?? 99,
  }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked[0].sr;
}

const allRestaurants = db.select({
  id: restaurants.id,
  name: restaurants.name,
  kitchenSubRoles: restaurants.kitchenSubRoles,
  floorSubRoles: restaurants.floorSubRoles,
  subroleHcrMap: restaurants.subroleHcrMap,
}).from(restaurants).all();

let totalUpdated = 0;
for (const r of allRestaurants) {
  const kitchen = JSON.parse(r.kitchenSubRoles || "[]") as string[];
  const salle = JSON.parse(r.floorSubRoles || "[]") as string[];
  const hcrMap = JSON.parse(r.subroleHcrMap || "{}") as Record<string, HcrLevel>;

  const lowestKitchen = lowestTier(kitchen, hcrMap, "Cuisinier");
  const lowestSalle = lowestTier(salle, hcrMap, "Serveur");

  const targets = db.select({
    id: staffingTargets.id,
    role: staffingTargets.role,
    count: staffingTargets.count,
    roleBreakdown: staffingTargets.roleBreakdown,
  })
  .from(staffingTargets)
  .where(and(
    eq(staffingTargets.restaurantId, r.id),
    sql`role_breakdown IS NULL OR role_breakdown = '' OR role_breakdown = '{}'`,
  ))
  .all();

  let updated = 0;
  for (const t of targets) {
    if (t.count <= 0) continue;
    const sr = t.role === "kitchen" ? lowestKitchen : lowestSalle;
    const breakdown = JSON.stringify({ [sr]: t.count });
    db.update(staffingTargets).set({ roleBreakdown: breakdown }).where(eq(staffingTargets.id, t.id)).run();
    updated++;
  }
  if (updated > 0) console.log(`  ${r.name}: ${updated} target(s) backfilled (kitchen→${lowestKitchen}, salle→${lowestSalle})`);
  totalUpdated += updated;
}

console.log(`\nDone. ${totalUpdated} staffing_target row(s) updated.`);
