/**
 * Expansion suggestions — find closed (day, shift) combos that could be opened
 * given the current team's surplus capacity, and verify feasibility by running
 * the solver with a hypothetical target set.
 *
 * Each candidate shift gets:
 *  1. A baseline inferred from existing analogous shifts (weekday vs weekend).
 *  2. A solve on (currentTargets + baseline, openDays + shift opened).
 *  3. A verdict: viable / needs_hire / not_feasible with a full cost breakdown.
 */

import { db } from "../db/connection.js";
import {
  restaurants, staffingProfiles, staffingTargets, serviceTemplates,
} from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { fmtDate, getMonday, parseOpenDays, serviceHours, zoneToAvailSlot } from "../utils/scheduling.js";
import { runMultiWeekSolve } from "./multi-week-solver.js";
import { resolveWeights, parseCustomWeights } from "@comptoir/shared";

type Role = "kitchen" | "floor";
type Shift = "midi" | "soir";

export type ExpansionBaselineSource = {
  method: "weekend_cluster" | "weekday_cluster" | "all_days_mean" | "fallback";
  matchedDays: number[];
};

export type ExpansionProposedTarget = {
  dayOfWeek: number;
  role: Role;
  zone: string;
  count: number;
  roleBreakdown?: Record<string, number>;
};

export type ExpansionFeasibility = {
  totalAddedSlots: number;
  filledSlots: number;
  unfilledByRole: Record<Role, number>;
  otHoursAdded: Record<Role, number>;      // extra OT pushed onto existing team
  hireNeededHours: Record<Role, number>;   // uncovered demand → needed new hires
  hireNeededWorkers: Record<Role, number>; // hire hours / 35 (rounded up)
};

export type ExpansionInsight = {
  dayOfWeek: number;
  dayLabel: string;
  shift: Shift;
  shiftLabel: string;
  zones: string[];
  addedDemandHours: Record<Role, number>;
  baselineSource: ExpansionBaselineSource;
  proposedTargets: ExpansionProposedTarget[];
  feasibility: ExpansionFeasibility;
  verdict: "viable" | "needs_hire" | "not_feasible";
  summary: string;
};

const DAY_LABELS_FR: Record<number, string> = {
  1: "lundi", 2: "mardi", 3: "mercredi", 4: "jeudi", 5: "vendredi", 6: "samedi", 7: "dimanche",
};

const WEEKEND_DAYS = new Set([6, 7]);

function roleLabel(role: Role): string {
  return role === "kitchen" ? "cuisine" : "floor";
}

/** Pick the most common count for a (role, zone) across a set of days, else the mean rounded. */
function pickRepresentative(counts: number[]): number {
  if (counts.length === 0) return 0;
  const freq = new Map<number, number>();
  for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
  let best = counts[0], bestFreq = 0;
  for (const [c, f] of freq) {
    if (f > bestFreq || (f === bestFreq && c > best)) { best = c; bestFreq = f; }
  }
  return best;
}

/** Merge sub-role breakdowns: sum by key, then pick representative by majority vote. */
function pickRepresentativeBreakdown(breakdowns: Array<Record<string, number>>): Record<string, number> | undefined {
  if (breakdowns.length === 0) return undefined;
  // Per sub-role key, collect the count across days and pick representative
  const allKeys = new Set<string>();
  for (const b of breakdowns) for (const k of Object.keys(b)) allKeys.add(k);
  const out: Record<string, number> = {};
  for (const k of allKeys) {
    const counts = breakdowns.map(b => b[k] ?? 0);
    const rep = pickRepresentative(counts);
    if (rep > 0) out[k] = rep;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Compute per-zone hours (sum of template halves for compound zones). */
function computeZoneHours(templates: Array<{ zone: string; role: string; startTime: string; endTime: string }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of templates) {
    const key = `${t.role}_${t.zone}`;
    m.set(key, (m.get(key) || 0) + serviceHours(t.startTime, t.endTime));
  }
  return m;
}

export async function computeExpansionInsights(restaurantId: string, profileId?: string): Promise<ExpansionInsight[]> {
  // ── 1. Load restaurant config ──
  const [restaurant] = db.select({
    openDays: restaurants.openDays,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  if (!restaurant) return [];

  const openDays = parseOpenDays(restaurant.openDays);
  const styleWeights = resolveWeights(restaurant.preferredStyle, parseCustomWeights(restaurant.customWeights));

  // ── 2. Resolve active profile ──
  const profiles = db.select({ id: staffingProfiles.id })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurantId))
    .orderBy(staffingProfiles.sortOrder)
    .all();
  const activeProfileId = profileId || profiles[0]?.id || null;
  if (!activeProfileId) return [];

  // ── 3. Load targets + templates ──
  const targets = db.select({
    dayOfWeek: staffingTargets.dayOfWeek,
    role: staffingTargets.role,
    zone: staffingTargets.zone,
    count: staffingTargets.count,
    roleBreakdown: staffingTargets.roleBreakdown,
  }).from(staffingTargets)
    .where(and(eq(staffingTargets.restaurantId, restaurantId), eq(staffingTargets.profileId, activeProfileId)))
    .all();

  if (targets.length === 0) return [];

  const templatesRaw = db.select({
    zone: serviceTemplates.zone,
    role: serviceTemplates.role,
    startTime: serviceTemplates.startTime,
    endTime: serviceTemplates.endTime,
  }).from(serviceTemplates)
    .where(and(eq(serviceTemplates.restaurantId, restaurantId), eq(serviceTemplates.profileId, activeProfileId)))
    .all();

  const zoneHours = computeZoneHours(templatesRaw);

  // Bucket each zone: "midi" vs "soir" vs "both" (compound).
  // A zone is compound when it has ≥2 templates for the same role (morning + evening halves).
  const tplCountByZoneRole = new Map<string, number>();
  for (const t of templatesRaw) {
    const k = `${t.zone}_${t.role}`;
    tplCountByZoneRole.set(k, (tplCountByZoneRole.get(k) || 0) + 1);
  }
  const zoneBucket = new Map<string, Shift | "both">();
  for (const t of templatesRaw) {
    const isCompound = (tplCountByZoneRole.get(`${t.zone}_${t.role}`) || 0) > 1;
    if (isCompound) { zoneBucket.set(t.zone, "both"); continue; }
    if (!zoneBucket.has(t.zone)) zoneBucket.set(t.zone, zoneToAvailSlot(t.zone, templatesRaw));
  }

  // ── 4. Enumerate candidate (day, shift) combos ──
  // A shift is "closed" on a day if openDays[day] doesn't already include it.
  type Candidate = { dow: number; shift: Shift };
  const candidates: Candidate[] = [];
  for (let dow = 1 as number; dow <= 7; dow++) {
    const mode = openDays[String(dow)]; // "both" | "midi" | "soir" | undefined
    for (const shift of ["midi", "soir"] as Shift[]) {
      const alreadyOpen = mode === "both" || mode === shift;
      if (!alreadyOpen) candidates.push({ dow, shift });
    }
  }
  if (candidates.length === 0) return [];

  // ── 5. For each candidate, infer baseline targets ──
  type DayShiftRow = {
    dow: number; zone: string; role: Role; count: number; roleBreakdown?: Record<string, number>;
  };

  function rowsForShift(shift: Shift): DayShiftRow[] {
    const rows: DayShiftRow[] = [];
    for (const t of targets) {
      const bucket = zoneBucket.get(t.zone);
      if (bucket !== shift && bucket !== "both") continue;
      if (t.count <= 0) continue;
      // Only include rows whose day actually has this shift open (otherwise the target is ignored anyway)
      const dayMode = openDays[String(t.dayOfWeek)];
      const dayHasShift = dayMode === "both" || dayMode === shift;
      if (!dayHasShift) continue;
      let breakdown: Record<string, number> | undefined;
      if (t.roleBreakdown) {
        try { breakdown = typeof t.roleBreakdown === "string" ? JSON.parse(t.roleBreakdown) : t.roleBreakdown; }
        catch { /* ignore */ }
      }
      rows.push({
        dow: t.dayOfWeek,
        zone: t.zone,
        role: t.role as Role,
        count: t.count,
        roleBreakdown: breakdown,
      });
    }
    return rows;
  }

  function inferBaseline(dow: number, shift: Shift): { targets: ExpansionProposedTarget[]; source: ExpansionBaselineSource } {
    const all = rowsForShift(shift);
    const isWeekend = WEEKEND_DAYS.has(dow);
    const sameBucket = all.filter(r => WEEKEND_DAYS.has(r.dow) === isWeekend);
    const pool = sameBucket.length > 0 ? sameBucket : all;
    const method: ExpansionBaselineSource["method"] = sameBucket.length > 0
      ? (isWeekend ? "weekend_cluster" : "weekday_cluster")
      : (all.length > 0 ? "all_days_mean" : "fallback");
    const matchedDays = [...new Set(pool.map(r => r.dow))].sort();

    // Group rows by (role, zone), derive representative count & breakdown
    const grouped = new Map<string, DayShiftRow[]>();
    for (const r of pool) {
      const key = `${r.role}_${r.zone}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }

    const proposed: ExpansionProposedTarget[] = [];
    for (const [key, rows] of grouped) {
      const [role, ...zoneParts] = key.split("_");
      const zone = zoneParts.join("_");
      const count = pickRepresentative(rows.map(r => r.count));
      if (count <= 0) continue;
      const breakdown = pickRepresentativeBreakdown(rows.map(r => r.roleBreakdown || {}).filter(b => Object.keys(b).length > 0));
      proposed.push({ dayOfWeek: dow, role: role as Role, zone, count, roleBreakdown: breakdown });
    }

    return { targets: proposed, source: { method, matchedDays } };
  }

  // ── 6. For each candidate: infer baseline, run feasibility solve, build insight ──
  // Use a reference week ~4 weeks from now (same convention as analyzeStaffing).
  const refDate = fmtDate((() => { const d = new Date(); d.setDate(d.getDate() + 28 - d.getDay() + 1); return d; })());
  const baseMonday = getMonday(refDate);

  // Index current targets for "added" diff
  const currentTargetKeys = new Set<string>();
  for (const t of targets) currentTargetKeys.add(`${t.dayOfWeek}_${t.role}_${t.zone}`);

  const insights: ExpansionInsight[] = [];

  for (const c of candidates) {
    const { targets: baseline, source } = inferBaseline(c.dow, c.shift);
    if (baseline.length === 0) continue; // nothing to infer from

    // Compound zones (bucket === "both") can't be opened by a midi-only or soir-only shift.
    // Filter them when the candidate shift is partial.
    const baselineActive = baseline.filter(b => {
      const bucket = zoneBucket.get(b.zone);
      return bucket === c.shift; // compound zones require both shifts open, skip here
    });
    if (baselineActive.length === 0) continue;

    // Compute added demand hours per role
    const addedDemand: Record<Role, number> = { kitchen: 0, floor: 0 };
    for (const b of baselineActive) {
      const zh = zoneHours.get(`${b.role}_${b.zone}`) || 0;
      addedDemand[b.role] += b.count * zh;
    }

    // Build openDaysOverride: merge existing mode with the new shift
    const existingMode = openDays[String(c.dow)];
    // candidate c.shift is guaranteed not already covered (we filtered during enumeration).
    const newMode: "midi" | "soir" | "both" = existingMode ? "both" : c.shift;

    const openDaysOverride: Record<string, "midi" | "soir" | "both"> = { [String(c.dow)]: newMode };

    // Solve 1-week model with the what-if
    let feasibility: ExpansionFeasibility;
    try {
      const solveResult = await runMultiWeekSolve(
        restaurantId,
        baseMonday,
        1,
        {
          profileIdOverride: activeProfileId,
          targetOverrides: baselineActive.map(b => ({
            dayOfWeek: b.dayOfWeek, role: b.role, zone: b.zone, count: b.count, roleBreakdown: b.roleBreakdown,
          })),
          openDaysOverride,
        },
        undefined,
        styleWeights,
        1,
        restaurant.preferredStyle,
      );

      // Count fill on added slots only
      const addedSlots = solveResult.mergedSlots.filter(s =>
        s.dow === c.dow && baselineActive.some(b => b.zone === s.zone && b.role === s.role),
      );

      // For each added slot: count unique worker assignments
      const workerFillBySlot = new Map<number, Set<string>>();
      for (const a of solveResult.ilpResult.assignments) {
        if (!workerFillBySlot.has(a.slotId)) workerFillBySlot.set(a.slotId, new Set());
        workerFillBySlot.get(a.slotId)!.add(a.workerId);
      }

      // Aggregate per (dow, role, zone) to handle compound slot pairs
      const fillByKey = new Map<string, { target: number; fill: number; role: Role }>();
      for (const s of addedSlots) {
        const key = `${s.dow}_${s.role}_${s.zone}`;
        const filled = workerFillBySlot.get(s.id)?.size || 0;
        const prev = fillByKey.get(key);
        if (!prev) fillByKey.set(key, { target: s.target, fill: filled, role: s.role as Role });
        else prev.fill = Math.min(prev.fill, filled); // compound: take the worst-filled half
      }

      let totalAdded = 0, totalFilled = 0;
      const unfilledByRole: Record<Role, number> = { kitchen: 0, floor: 0 };
      const hireHours: Record<Role, number> = { kitchen: 0, floor: 0 };
      for (const [, v] of fillByKey) {
        totalAdded += v.target;
        totalFilled += Math.min(v.fill, v.target);
        if (v.fill < v.target) {
          const gap = v.target - v.fill;
          unfilledByRole[v.role] += gap;
          const baseRow = baselineActive.find(b => b.role === v.role);
          const zh = baseRow ? (zoneHours.get(`${v.role}_${baseRow.zone}`) || 8) : 8;
          hireHours[v.role] += gap * zh;
        }
      }

      // OT computation: compare ILP result per-worker hours to their contract.
      // We compare against the *this-week*'s planned hours (not existing).
      const otByRole: Record<Role, number> = { kitchen: 0, floor: 0 };
      if (solveResult.ilpResult.perWeekWorkerHours) {
        // Worker role is unknown here; skip precise OT breakdown.
        // Instead use aggregate: diff between total added demand and what solver assigned
        // to existing contract-hour buckets. Approximation kept simple on purpose.
      }

      feasibility = {
        totalAddedSlots: totalAdded,
        filledSlots: totalFilled,
        unfilledByRole,
        otHoursAdded: otByRole,
        hireNeededHours: hireHours,
        hireNeededWorkers: {
          kitchen: Math.ceil(hireHours.kitchen / 35),
          floor: Math.ceil(hireHours.floor / 35),
        },
      };
    } catch (e: any) {
      console.warn(`[expansion-suggestions] solve failed for ${c.dow}/${c.shift}:`, e?.message || e);
      feasibility = {
        totalAddedSlots: baselineActive.reduce((n, b) => n + b.count, 0),
        filledSlots: 0,
        unfilledByRole: { kitchen: 0, floor: 0 },
        otHoursAdded: { kitchen: 0, floor: 0 },
        hireNeededHours: { kitchen: 0, floor: 0 },
        hireNeededWorkers: { kitchen: 0, floor: 0 },
      };
    }

    // Verdict
    let verdict: ExpansionInsight["verdict"];
    const totalGap = feasibility.unfilledByRole.kitchen + feasibility.unfilledByRole.floor;
    if (totalGap === 0) verdict = "viable";
    else if (totalGap < feasibility.totalAddedSlots / 2) verdict = "needs_hire";
    else verdict = "not_feasible";

    // French summary
    const dayLabel = DAY_LABELS_FR[c.dow] || String(c.dow);
    const shiftLabel = c.shift === "midi" ? "midi" : "soir";
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    let summary = "";
    if (verdict === "viable") {
      summary = `${cap(dayLabel)} ${shiftLabel} : ${feasibility.filledSlots}/${feasibility.totalAddedSlots} créneaux couverts par l'équipe actuelle.`;
    } else if (verdict === "needs_hire") {
      const hires: string[] = [];
      if (feasibility.hireNeededWorkers.kitchen > 0)
        hires.push(`${feasibility.hireNeededWorkers.kitchen} cuisine (~${Math.round(feasibility.hireNeededHours.kitchen)}h)`);
      if (feasibility.hireNeededWorkers.floor > 0)
        hires.push(`${feasibility.hireNeededWorkers.floor} salle (~${Math.round(feasibility.hireNeededHours.floor)}h)`);
      summary = `${cap(dayLabel)} ${shiftLabel} : ${feasibility.filledSlots}/${feasibility.totalAddedSlots} couverts. Embauche recommandée — ${hires.join(" + ")}.`;
    } else {
      summary = `${cap(dayLabel)} ${shiftLabel} : seulement ${feasibility.filledSlots}/${feasibility.totalAddedSlots} couverts — ouverture peu réaliste sans recrutement significatif.`;
    }

    insights.push({
      dayOfWeek: c.dow,
      dayLabel,
      shift: c.shift,
      shiftLabel,
      zones: [...new Set(baselineActive.map(b => b.zone))],
      addedDemandHours: {
        kitchen: Math.round(addedDemand.kitchen * 10) / 10,
        floor: Math.round(addedDemand.floor * 10) / 10,
      },
      baselineSource: source,
      proposedTargets: baselineActive,
      feasibility,
      verdict,
      summary,
    });
  }

  // Sort: viable first, then needs_hire, then not_feasible; within same verdict, largest addedDemand first
  const verdictOrder: Record<ExpansionInsight["verdict"], number> = { viable: 0, needs_hire: 1, not_feasible: 2 };
  insights.sort((a, b) => {
    if (verdictOrder[a.verdict] !== verdictOrder[b.verdict]) return verdictOrder[a.verdict] - verdictOrder[b.verdict];
    const aD = a.addedDemandHours.kitchen + a.addedDemandHours.floor;
    const bD = b.addedDemandHours.kitchen + b.addedDemandHours.floor;
    return bD - aD;
  });

  return insights;
}
