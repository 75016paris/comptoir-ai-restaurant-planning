// Calibration metrics — computed on solver output, no DB or human input required.
//
// Hard floor (disqualify a config):
//   * Fill rate ≥ 95% of feasible-fill (NOT 95% of target — over-stretched scenarios get a pass)
//
// Composite metrics (ranked when floor passes):
//   * OT fairness (Gini coefficient of overtime-hours-per-willing-worker, lower=better)  weight 3
//   * Contract adherence (mean |hours_assigned - contractHours|, lower=better)            weight 2
//   * Consistency (% week-1 (worker, dow, zone) tuples present in week-2)                 weight 2
//   * Sub-role accuracy (% slots whose roleBreakdown is satisfied by assigned workers)    weight 2
//   * Chef coverage (% chef-required slots with a chef/sous-chef assigned)                weight 2
//   * Preference match rate (always 0 in synthetic — kept for parity with prod)           weight 1
//
// Chef coverage was originally a hard floor but synthetic restaurants with small chef rosters
// can't physically cover every soir slot across 4 weeks; treating it as a soft signal lets the
// solver be ranked on how well it allocates the chefs it has rather than disqualifying configs
// for restaurant-design impossibilities.

import type { ILPResult } from "../../../src/utils/ilp-solver.js";
import type { SolveInputs } from "./scenarios.js";
import { canFillChefSlot } from "@comptoir/shared";

export interface MetricResult {
  // Hard floor
  fillRate: number;          // assigned-hours / feasible-demand (0..1)
  // Soft (composite) — all in [0, 1] after normalization
  chefCoverage: number;      // chef-zones-covered / chef-zones-total (1.0 if no chef zones)
  otFairness: number;        // 1 - gini of OT hours among willing workers
  contractAdherence: number; // 1 - mean(|delta| / contract)
  consistency: number;       // % week-over-week (worker, dow, zone) repeats
  subroleAccuracy: number;   // % slots with breakdown that have correct sub-roles
  preferenceMatch: number;   // synthetic has no prefs → always 0 (kept for parity)
  // Sharper, weight-sensitive signals added after coarse-sweep revealed the first batch was flat:
  workloadSpread: number;    // 1 - gini of total hours across ALL available workers (not just willing)
  priorityUtilization: number; // correlation between priority (lower=better) and assigned hours
  coupureDiscipline: number; // for compound slots: % paired correctly (both halves, same worker)
  // Personal-life signals (added after user flagged "similar shifts per week"):
  weekShape: number;         // % worker-weeks with exactly one contiguous work-block — consolidated vs scattered
  dowPatternStability: number; // % of (worker, dow) tuples that repeat week-over-week — predictable days
  // Resilience — ground-truth backup pool size per assignment. For each (worker, slot)
  // assignment, count OTHER workers eligible for that slot who are NOT working that day
  // in the solution; take the mean across assignments. Higher = more replacement capacity if
  // someone cancels. Normalized to [0, 1] by dividing by a saturation ceiling (3).
  resilience: number;
  resilienceRaw: number;     // unnormalized mean backup count (diagnostic)
  // Cost efficiency — hours-weighted mean assigned wage, normalized against the per-role
  // rate distribution in the roster. 1.0 = always picked the role-cheapest, 0.0 = always
  // picked role-costliest, 0.5 = role-mean. Computed per-role then hours-weighted so that
  // kitchen-vs-salle rate differences don't dominate. 0.5 when no rate variance exists.
  costEfficiency: number;
  payrollCents: number;      // total labour cost of the solution (diagnostic)
  // Aggregates
  composite: number;
  passes: boolean;
  disqualifyReason?: string;
}

const HARD_FLOOR_FILL = 0.95;         // 95% of feasible

const W_FAIRNESS = 3;
const W_ADHERENCE = 2;
const W_CONSISTENCY = 2;
const W_SUBROLE = 2;
const W_CHEF = 2;
const W_PREF = 1;
const W_SPREAD = 3;      // strong — "did the solver use the whole team or hammer 2 people?"
const W_PRIORITY = 2;    // "did high-priority workers actually get more shifts?"
const W_COUPURE = 1;     // "did compound (split-shift) slots pair correctly?"
const W_WEEK_SHAPE = 3;  // "are work days contiguous?" — high personal-life importance
const W_DOW_STABLE = 2;  // "does each worker work the same days each week?"
const W_RESILIENCE = 2;  // "if someone calls out, how many replacement candidates remain?"

// Saturation ceiling for resilience normalization. Raw mean backup count ≥ 20 maps to 1.0;
// below that scales linearly. Large teams (50 workers) realistically hit 15-20, small
// teams (6 workers) hit 2-3 — so ceiling=20 keeps the metric differentiable across the
// whole sweep. Chosen empirically from the v2 smoke-test documented in the internal notes.
const RESILIENCE_CEILING = 20;
// Hard floor — below this average backup count, the preset isn't providing meaningful
// resilience at all. Disqualifies configs where redundancy weight is too low to shift
// assignments in the solution (per the session plan).
const RESILIENCE_FLOOR_RAW = 0.5;

export function computeMetrics(inputs: SolveInputs, result: ILPResult): MetricResult {
  if (result.status === "infeasible" || result.status === "error") {
    return {
      fillRate: 0, chefCoverage: 0, otFairness: 0, contractAdherence: 0,
      consistency: 0, subroleAccuracy: 0, preferenceMatch: 0,
      workloadSpread: 0, priorityUtilization: 0, coupureDiscipline: 0,
      weekShape: 0, dowPatternStability: 0,
      resilience: 0, resilienceRaw: 0,
      costEfficiency: 0, payrollCents: 0,
      composite: 0, passes: false, disqualifyReason: `solver-${result.status}`,
    };
  }

  // Per-worker, per-slot lookups
  const workersById = new Map(inputs.workers.map(w => [w.id, w]));
  const slotsById = new Map(inputs.slots.map(s => [s.id, s]));
  const assignsByWorker = new Map<string, number[]>();
  const assignsBySlot = new Map<number, string[]>();
  for (const a of result.assignments) {
    if (!assignsByWorker.has(a.workerId)) assignsByWorker.set(a.workerId, []);
    assignsByWorker.get(a.workerId)!.push(a.slotId);
    if (!assignsBySlot.has(a.slotId)) assignsBySlot.set(a.slotId, []);
    assignsBySlot.get(a.slotId)!.push(a.workerId);
  }

  // ── Fill rate (vs. capacity-feasible-fill, NOT vs. target) ──
  // Feasible fill = min(target × hours, theoretical capacity for that slot)
  // Simple proxy: total assigned hours / total demand hours (clipped at total capacity).
  const totalAssignedHours = result.assignments
    .reduce((s, a) => s + (slotsById.get(a.slotId)?.hours ?? 0), 0);
  const feasibleDemand = Math.min(inputs.totalDemandHours, inputs.totalCapacityHours);
  const fillRate = feasibleDemand > 0 ? Math.min(1, totalAssignedHours / feasibleDemand) : 1;

  // ── Chef coverage ──
  // For each slot whose zone+role appears in chefZones, check at least one assigned worker is chef/sous-chef.
  // (Synthetic chefZones format matches `${zone}_${role}` from generator.)
  // We don't have config.chefZones in inputs — re-derive from slots whose zone is "soir" and roleBreakdown has chef.
  let chefRequired = 0, chefCovered = 0;
  for (const slot of inputs.slots) {
    const requiresChef = slot.zone === "soir";
    if (!requiresChef) continue;
    chefRequired++;
    const assignedWorkerIds = assignsBySlot.get(slot.id) ?? [];
    const hasChef = assignedWorkerIds.some(wid => {
      const w = workersById.get(wid);
      return w && canFillChefSlot(w.subRoles);
    });
    if (hasChef) chefCovered++;
  }
  const chefCoverage = chefRequired === 0 ? 1.0 : chefCovered / chefRequired;

  // ── OT fairness (Gini of OT hours among willing workers) ──
  const willingWorkers = inputs.workers.filter(w => w.overtimeWilling);
  const otHours: number[] = [];
  for (const w of willingWorkers) {
    const slotsAssigned = assignsByWorker.get(w.id) ?? [];
    const hours = slotsAssigned.reduce((s, sid) => s + (slotsById.get(sid)?.hours ?? 0), 0);
    const numWeeks = inputs.multiWeek?.numWeeks ?? 1;
    const ot = Math.max(0, hours - w.contractHours * numWeeks);
    otHours.push(ot);
  }
  const otFairness = willingWorkers.length === 0 ? 1.0 : 1 - gini(otHours);

  // ── Contract adherence (mean |hours - contract| / contract) ──
  let totalAdhDelta = 0, adhWorkers = 0;
  for (const w of inputs.workers) {
    if (w.contractHours <= 0) continue;
    const slotsAssigned = assignsByWorker.get(w.id) ?? [];
    const hours = slotsAssigned.reduce((s, sid) => s + (slotsById.get(sid)?.hours ?? 0), 0);
    const numWeeks = inputs.multiWeek?.numWeeks ?? 1;
    const expected = w.contractHours * numWeeks;
    totalAdhDelta += Math.abs(hours - expected) / expected;
    adhWorkers++;
  }
  const contractAdherence = adhWorkers === 0 ? 1.0 : 1 - Math.min(1, totalAdhDelta / adhWorkers);

  // ── Consistency (week-over-week (worker, dow, zone) repeat rate) ──
  // For each (worker, dow, zone) tuple in week k, check if the same tuple exists in week k+1.
  const numWeeks = inputs.multiWeek?.numWeeks ?? 1;
  let totalTuples = 0, repeatedTuples = 0;
  if (numWeeks >= 2) {
    const tuplesByWeek: Map<string, Set<string>> = new Map();
    for (let w = 0; w < numWeeks; w++) tuplesByWeek.set(`w${w}`, new Set());
    for (const a of result.assignments) {
      const slot = slotsById.get(a.slotId);
      if (!slot) continue;
      const wk = slot.week ?? 0;
      tuplesByWeek.get(`w${wk}`)?.add(`${a.workerId}_${slot.dow}_${slot.zone}`);
    }
    for (let w = 0; w < numWeeks - 1; w++) {
      const a = tuplesByWeek.get(`w${w}`) ?? new Set();
      const b = tuplesByWeek.get(`w${w + 1}`) ?? new Set();
      for (const t of a) {
        totalTuples++;
        if (b.has(t)) repeatedTuples++;
      }
    }
  }
  const consistency = totalTuples === 0 ? 1.0 : repeatedTuples / totalTuples;

  // ── Sub-role accuracy ──
  let subroleSlotsTotal = 0, subroleSlotsOk = 0;
  for (const slot of inputs.slots) {
    if (!slot.roleBreakdown || Object.keys(slot.roleBreakdown).length === 0) continue;
    subroleSlotsTotal++;
    const assignedWorkerIds = assignsBySlot.get(slot.id) ?? [];
    const need = { ...slot.roleBreakdown };
    let ok = true;
    for (const wid of assignedWorkerIds) {
      const w = workersById.get(wid);
      if (!w) continue;
      // Greedy: count this worker against any sub-role they have that's still needed.
      for (const sr of w.subRoles) {
        if (need[sr] > 0) { need[sr]--; break; }
      }
    }
    for (const [, n] of Object.entries(need)) if (n > 0) { ok = false; break; }
    if (ok) subroleSlotsOk++;
  }
  const subroleAccuracy = subroleSlotsTotal === 0 ? 1.0 : subroleSlotsOk / subroleSlotsTotal;

  // ── Preference match (always 0 in synthetic, kept for parity) ──
  const preferenceMatch = 0;

  // ── Workload spread (Gini across ALL available workers, not just willing) ──
  // Reveals whether the solver balances hours or hammers a few workers. Weight-sensitive
  // because fill/bucket weights push the solver toward/away from concentration.
  const allWorkerHours: number[] = [];
  for (const w of inputs.workers) {
    const slotsAssigned = assignsByWorker.get(w.id) ?? [];
    const hours = slotsAssigned.reduce((s, sid) => s + (slotsById.get(sid)?.hours ?? 0), 0);
    allWorkerHours.push(hours);
  }
  const workloadSpread = inputs.workers.length <= 1 ? 1.0 : 1 - gini(allWorkerHours);

  // ── Priority utilization (Spearman-like correlation: lower-priority-number gets more hours) ──
  // Normalized to [0, 1]. A result of 1.0 means priorities are perfectly respected.
  let priorityUtilization = 0.5;
  {
    const pairs = inputs.workers.map((w, i) => ({
      priority: w.priority,
      hours: allWorkerHours[i],
    }));
    // Sort by priority ascending (1 = best); tied ranks averaged.
    pairs.sort((a, b) => a.priority - b.priority);
    // Compute fraction of pairs where earlier (better-priority) has >= later's hours.
    if (pairs.length >= 2) {
      let correctlyOrdered = 0, totalPairs = 0;
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          if (pairs[i].priority === pairs[j].priority) continue;
          totalPairs++;
          if (pairs[i].hours >= pairs[j].hours) correctlyOrdered++;
        }
      }
      priorityUtilization = totalPairs === 0 ? 0.5 : correctlyOrdered / totalPairs;
    }
  }

  // ── Week shape: % of (worker, week) with exactly ONE contiguous work-block ──
  // Measures personal-life quality: working Mon-Fri (1 block) beats Mon/Wed/Fri (3 blocks).
  // Also computes dowPatternStability: % of (worker, dow) tuples that repeat across weeks.
  let consolidatedWeeks = 0, totalWorkerWeeks = 0;
  const dowByWorkerWeek = new Map<string, Set<number>>(); // "workerId_week" → set of dows
  for (const a of result.assignments) {
    const slot = slotsById.get(a.slotId);
    if (!slot) continue;
    const k = `${a.workerId}_${slot.week ?? 0}`;
    if (!dowByWorkerWeek.has(k)) dowByWorkerWeek.set(k, new Set());
    dowByWorkerWeek.get(k)!.add(slot.dow);
  }
  for (const [, dows] of dowByWorkerWeek) {
    totalWorkerWeeks++;
    const sorted = [...dows].sort((a, b) => a - b);
    // Count contiguous runs (1..7 ISO days, no wrap-around).
    let runs = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) runs++;
    }
    if (runs === 1) consolidatedWeeks++;
  }
  const weekShape = totalWorkerWeeks === 0 ? 1.0 : consolidatedWeeks / totalWorkerWeeks;

  // dowPatternStability: across weeks, % of (worker, dow) tuples seen in ≥2 weeks / total (worker, dow) seen.
  let stableTuples = 0, totalTuplesSeen = 0;
  const dowCountByWorker = new Map<string, Map<number, number>>();
  for (const [k, dows] of dowByWorkerWeek) {
    const workerId = k.split("_")[0];
    if (!dowCountByWorker.has(workerId)) dowCountByWorker.set(workerId, new Map());
    const wm = dowCountByWorker.get(workerId)!;
    for (const d of dows) wm.set(d, (wm.get(d) ?? 0) + 1);
  }
  for (const [, wm] of dowCountByWorker) {
    for (const [, count] of wm) {
      totalTuplesSeen++;
      if (count >= 2) stableTuples++;
    }
  }
  const dowPatternStability = totalTuplesSeen === 0 ? 1.0 : stableTuples / totalTuplesSeen;

  // ── Resilience: ground-truth backup pool per assignment ──
  // For each (worker, slot) in the solution, count OTHER workers who (a) share the role,
  // (b) pass isAvailable for the slot, and (c) aren't already working that date in the solution.
  // Mean across all assignments = expected replacement candidates if someone cancels.
  const workingDatesByWorker = new Map<string, Set<string>>();
  for (const a of result.assignments) {
    const s = slotsById.get(a.slotId);
    if (!s) continue;
    if (!workingDatesByWorker.has(a.workerId)) workingDatesByWorker.set(a.workerId, new Set());
    workingDatesByWorker.get(a.workerId)!.add(s.date);
  }
  let resBackupSum = 0;
  let resAssignments = 0;
  for (const a of result.assignments) {
    const slot = slotsById.get(a.slotId);
    if (!slot) continue;
    let backups = 0;
    for (const other of inputs.workers) {
      if (other.id === a.workerId) continue;
      if (other.role !== slot.role) continue;
      if (!inputs.checker.isAvailable(other.id, slot)) continue;
      const otherDates = workingDatesByWorker.get(other.id);
      if (otherDates?.has(slot.date)) continue;
      backups++;
    }
    resBackupSum += backups;
    resAssignments++;
  }
  const resilienceRaw = resAssignments === 0 ? 0 : resBackupSum / resAssignments;
  const resilience = Math.min(1, resilienceRaw / RESILIENCE_CEILING);

  // ── Cost efficiency ──
  // Per role, rank workers by hourlyRateCents. For each assignment, ask: where does the
  // assigned worker's rate sit within the role's [min, max] band? 0 = min (cheapest),
  // 1 = max (costliest). Hours-weight the per-assignment positions, then invert so that
  // picking cheaper = higher score.
  // Degenerate: if a role has only one worker, or min === max, contribute 0.5 (neutral).
  let weightedPosSum = 0;
  let weightedHours = 0;
  let payrollCents = 0;
  const rosterByRole = new Map<string, Array<{ w: (typeof inputs.workers)[number]; rate: number }>>();
  for (const w of inputs.workers) {
    if (!w.hourlyRateCents || w.hourlyRateCents <= 0) continue;
    if (!rosterByRole.has(w.role)) rosterByRole.set(w.role, []);
    rosterByRole.get(w.role)!.push({ w, rate: w.hourlyRateCents });
  }
  const roleBand = new Map<string, { min: number; max: number }>();
  for (const [role, arr] of rosterByRole) {
    const rates = arr.map(x => x.rate);
    roleBand.set(role, { min: Math.min(...rates), max: Math.max(...rates) });
  }
  for (const a of result.assignments) {
    const slot = slotsById.get(a.slotId);
    const w = workersById.get(a.workerId);
    if (!slot || !w || !w.hourlyRateCents || w.hourlyRateCents <= 0) continue;
    payrollCents += Math.round(w.hourlyRateCents * slot.hours);
    const band = roleBand.get(w.role);
    if (!band || band.max === band.min) {
      weightedPosSum += 0.5 * slot.hours;
    } else {
      const pos = (w.hourlyRateCents - band.min) / (band.max - band.min);
      weightedPosSum += pos * slot.hours;
    }
    weightedHours += slot.hours;
  }
  const costEfficiency = weightedHours === 0 ? 0.5 : 1 - (weightedPosSum / weightedHours);

  // ── Coupure discipline: compound slots should have the same worker on both halves ──
  let compoundPairs = 0, compoundDone = 0;
  const seen = new Set<number>();
  for (const slot of inputs.slots) {
    if (!slot.compound || !slot.compoundPairId || seen.has(slot.id)) continue;
    seen.add(slot.id);
    seen.add(slot.compoundPairId);
    compoundPairs++;
    const aWorkers = new Set(assignsBySlot.get(slot.id) ?? []);
    const bWorkers = new Set(assignsBySlot.get(slot.compoundPairId) ?? []);
    // Count a "done" if at least one worker appears in both.
    let intersect = false;
    for (const w of aWorkers) if (bWorkers.has(w)) { intersect = true; break; }
    if (intersect) compoundDone++;
  }
  const coupureDiscipline = compoundPairs === 0 ? 1.0 : compoundDone / compoundPairs;

  // ── Hard floor check ──
  let passes = true;
  let disqualifyReason: string | undefined;
  if (fillRate < HARD_FLOOR_FILL) {
    passes = false;
    disqualifyReason = `fill-rate ${(fillRate * 100).toFixed(1)}% < 95%`;
  }

  // ── Composite score ──
  // Degeneracy gate: empty or near-empty schedules score artificially high on
  // metrics that hit trivial bounds on zero assignments (consistency, dow stability,
  // coupure, workload-spread all → 1.0 when there's nothing to score). Cost-sweep
  // 2026-04-21 had CA≥40 configs collapsing to fillRate≤0.14 yet scoring composite
  // 0.680 — higher than any real schedule. We gate by fillRate/0.5 so schedules
  // ≥50% filled are untouched and sub-50% degrade linearly to 0 at empty.
  const totalWeight = W_FAIRNESS + W_ADHERENCE + W_CONSISTENCY + W_SUBROLE + W_CHEF + W_PREF
                    + W_SPREAD + W_PRIORITY + W_COUPURE + W_WEEK_SHAPE + W_DOW_STABLE + W_RESILIENCE;
  const compositeRaw = (
    W_FAIRNESS * otFairness
    + W_ADHERENCE * contractAdherence
    + W_CONSISTENCY * consistency
    + W_SUBROLE * subroleAccuracy
    + W_CHEF * chefCoverage
    + W_PREF * preferenceMatch
    + W_SPREAD * workloadSpread
    + W_PRIORITY * priorityUtilization
    + W_COUPURE * coupureDiscipline
    + W_WEEK_SHAPE * weekShape
    + W_DOW_STABLE * dowPatternStability
    + W_RESILIENCE * resilience
  ) / totalWeight;
  const composite = compositeRaw * Math.min(1, fillRate / 0.5);

  return {
    fillRate, chefCoverage, otFairness, contractAdherence,
    consistency, subroleAccuracy, preferenceMatch,
    workloadSpread, priorityUtilization, coupureDiscipline,
    weekShape, dowPatternStability,
    resilience, resilienceRaw,
    costEfficiency, payrollCents,
    composite, passes, disqualifyReason,
  };
}

export { RESILIENCE_FLOOR_RAW };

// Gini coefficient: 0 = perfect equality, 1 = max inequality.
// For a (sorted ascending) array of non-negative values.
function gini(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (2 * (i + 1) - n - 1) * sorted[i];
  return weighted / (n * total);
}
