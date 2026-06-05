/**
 * Tiered infeasibility fallback for the staffing solver.
 *
 * When the primary solve returns `infeasible`, retry with progressively relaxed
 * constraints. Each tier is a distinct solver call so callers know exactly which
 * relaxation unlocked the plan.
 *
 *   Tier 0 — current model (no relaxation).
 *   Tier 1 — soft slot-fill floors (C1b), penalty M_slot = 100_000_000 per unit.
 *   Tier 2 — Tier 1 + soft personal/controlled weekly OT cap (C5) with +2h slack
 *            at M_c5 = 2_000_000/h, plus auto-bypass of C7/C8
 *            (max-consecutive-days + rolling-rest). The HCR 48h weekly maximum
 *            remains a hard cap in every tier.
 *            M_c5 is per-hour-of-violation by contract (see ILPConfig.softC5Penalty).
 *            ILP expresses C5 in hours and applies it directly. CP-SAT expresses
 *            C5 in minutes and divides by SCALE at the payload site so the
 *            effective per-hour penalty matches across backends (audit H6).
 *   Tier 3 — greedy heuristic, no solver, still capped at the normal HCR 48h.
 *   Tier 4 — exceptional crisis greedy pass, capped at 60h and always reported
 *            as a compliance warning when a worker crosses 48h.
 *
 * Callers opt in with `maxTier` (preview passes 1, generate passes 4).
 * `SOLVER_MAX_TIER` env var clamps the ceiling (default 4). A feasible result
 * only stops the tier ladder when every target slot is filled; otherwise the
 * solver keeps escalating so generation is fill-first while surfacing warnings.
 */

import {
  pickBestSubRoleMatch,
  type ILPResult,
  type ILPWorker,
  type ILPSlot,
  type ILPConfig,
  type AvailabilityChecker,
  type MultiWeekConfig,
  type SlotFillFloors,
} from "./ilp-solver.js";
import { solveWithFallback } from "./solver-fallback.js";
import { timesOverlap } from "./scheduling.js";
import type { HintAssignment } from "../services/hint-store.js";
import { DEFAULT_WEIGHTS, type WeightConfig } from "@comptoir/shared";

const M_SLOT = 100_000_000;
const M_C5 = 2_000_000;
const C5_EXTRA_HOURS = 2;
const GREEDY_HARD_CAP = 48;
const EXCEPTIONAL_WEEKLY_CAP = 60;

type TierSolver = typeof solveWithFallback;

/**
 * Indirection seam for tests (same pattern as solver-fallback).
 * Production code never mutates this.
 */
export const tierSolvers: { solve: TierSolver } = {
  solve: solveWithFallback,
};

function envMaxTier(): number {
  const raw = process.env.SOLVER_MAX_TIER;
  if (raw === undefined || raw === "") return 4;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 4;
  return Math.max(0, Math.min(4, n));
}

function feasible(r: ILPResult): boolean {
  return r.status === "optimal" || r.status === "feasible";
}

function addDaysStr(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function windowDates(startDate: string, len: number): string[] {
  return Array.from({ length: len }, (_, i) => addDaysStr(startDate, i));
}

/**
 * Compute per-slot shortages by comparing assigned counts to slot targets.
 * Deduplicates compound pairs (reports shortage once per pair on the lower-ID slot).
 */
function computeUnfilledSlots(slots: ILPSlot[], assignments: ILPResult["assignments"]): Array<{ slotId: number; shortage: number }> {
  const counts = new Map<number, number>();
  for (const a of assignments) counts.set(a.slotId, (counts.get(a.slotId) ?? 0) + 1);
  const out: Array<{ slotId: number; shortage: number }> = [];
  for (const s of slots) {
    // Skip paired compound second half (shortage is the same as the first half).
    if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) continue;
    const need = Math.max(0, s.target - s.existingFill);
    if (need === 0) continue;
    const got = counts.get(s.id) ?? 0;
    const shortage = need - got;
    if (shortage > 0) out.push({ slotId: s.id, shortage });
  }
  return out;
}

function buildTargetFillFloors(slots: ILPSlot[], existing?: SlotFillFloors): SlotFillFloors {
  const floors = new Map(existing ?? []);
  const targetFloors = new Map<string, number>();
  for (const s of slots) {
    const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
    targetFloors.set(key, (targetFloors.get(key) ?? 0) + s.target);
  }
  for (const [key, target] of targetFloors) {
    floors.set(key, Math.max(floors.get(key) ?? 0, target));
  }
  return floors;
}

/**
 * Detect per-worker OT excess when C5 was softened.
 *   planned hours + existing hours > cap  →  excess recorded.
 * For multi-week, checks every week that exceeds the cap.
 */
function computeComplianceWarnings(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  assignments: ILPResult["assignments"],
  multiWeek: MultiWeekConfig | undefined,
  perWeekWorkerHours: Map<string, number[]> | undefined,
): NonNullable<ILPResult["complianceWarnings"]> {
  const warnings: Array<{ workerId: string; rule: string; excessHours: number }> = [];
  const slotMap = new Map(slots.map(s => [s.id, s]));

  const personalCapFor = (w: ILPWorker): number => {
    const effective = w.otCap ?? config.otCap;
    const configuredCap = w.contractHours != null && w.contractHours === 0 ? 0
      : w.contractHours != null ? Math.max(w.contractHours, effective) : effective;
    return Math.min(configuredCap, GREEDY_HARD_CAP);
  };

  const pushWarning = (workerId: string, total: number, personalCap: number) => {
    if (total > GREEDY_HARD_CAP) {
      warnings.push({
        workerId,
        rule: "HCR-L3121-20",
        excessHours: Math.round((total - GREEDY_HARD_CAP) * 100) / 100,
      });
      return;
    }
    if (personalCap > 0 && personalCap < GREEDY_HARD_CAP && total > personalCap) {
      warnings.push({
        workerId,
        rule: "HCR-L3121-22-weekly",
        excessHours: Math.round((total - personalCap) * 100) / 100,
      });
    }
  };

  if (multiWeek && perWeekWorkerHours) {
    for (const w of workers) {
      const cap = personalCapFor(w);
      if (cap <= 0) continue;
      const planned = perWeekWorkerHours.get(w.id) ?? [];
      const existing = multiWeek.existingHoursByWeek.get(w.id) ?? [];
      for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
        const total = (planned[wk] ?? 0) + (existing[wk] ?? 0);
        pushWarning(w.id, total, cap);
      }
    }
  } else {
    // Single-week: compute planned hours per worker from assignments.
    const plannedByWorker = new Map<string, number>();
    for (const a of assignments) {
      const s = slotMap.get(a.slotId);
      if (!s) continue;
      plannedByWorker.set(a.workerId, (plannedByWorker.get(a.workerId) ?? 0) + s.hours);
    }
    for (const w of workers) {
      const cap = personalCapFor(w);
      if (cap <= 0) continue;
      const total = (plannedByWorker.get(w.id) ?? 0) + w.existingWeeklyHours;
      pushWarning(w.id, total, cap);
    }
  }
  return warnings;
}

function computeBypassedRestWarnings(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  assignments: ILPResult["assignments"],
): NonNullable<ILPResult["complianceWarnings"]> {
  const slotMap = new Map(slots.map(s => [s.id, s]));
  const workedDatesByWorker = new Map<string, Set<string>>();
  for (const w of workers) workedDatesByWorker.set(w.id, new Set(w.existingWorkDates));
  for (const a of assignments) {
    const s = slotMap.get(a.slotId);
    if (!s) continue;
    if (!workedDatesByWorker.has(a.workerId)) workedDatesByWorker.set(a.workerId, new Set());
    workedDatesByWorker.get(a.workerId)!.add(s.date);
  }

  const warnings: NonNullable<ILPResult["complianceWarnings"]> = [];
  for (const w of workers) {
    const dates = [...(workedDatesByWorker.get(w.id) ?? new Set<string>())].sort();
    if (dates.length === 0) continue;

    let maxConsecutiveExcess = 0;
    let maxRollingExcess = 0;
    const emittedWindows = new Set<string>();
    for (const pivotDate of dates) {
      for (let offset = -6; offset <= 0; offset++) {
        const start = addDaysStr(pivotDate, offset);
        if (emittedWindows.has(start)) continue;
        emittedWindows.add(start);
        const count = windowDates(start, 7).filter(d => workedDatesByWorker.get(w.id)!.has(d)).length;
        maxConsecutiveExcess = Math.max(maxConsecutiveExcess, count - config.maxConsecutiveDays);
        maxRollingExcess = Math.max(maxRollingExcess, count - config.maxRollingWorkDays);
      }
    }

    if (maxConsecutiveExcess > 0) {
      warnings.push({ workerId: w.id, rule: "HCR-L3132-1", excessHours: maxConsecutiveExcess });
    }
    if (maxRollingExcess > 0) {
      warnings.push({ workerId: w.id, rule: "HCR-L3132-2", excessHours: maxRollingExcess });
    }
  }
  return warnings;
}

/**
 * Greedy fallback. No solver — just rank-and-fill with a fixed weekly cap
 * and respect for role, availability, pre-existing services, and in-pass overlap.
 *
 * Slot criticality = (target - existingFill) × dayPriority. We keep it deliberately
 * simple since Tier 3 only triggers when everything else has failed.
 */
export function greedyFallback(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  checker: AvailabilityChecker,
  multiWeek?: MultiWeekConfig,
  weeklyCap: number = GREEDY_HARD_CAP,
  solveTier: 3 | 4 = 3,
  relaxations: string[] = ["greedy-fallback"],
): ILPResult {
  const startTime = performance.now();

  // Normalize day priorities (map: "dow" → weight). Default to 1 when missing.
  const dayWeight = (dow: number): number => {
    const raw = config.dayPriorityMap?.[String(dow)];
    return typeof raw === "number" && raw > 0 ? raw : 1;
  };

  // Compound pair representative only — greedy commits both halves as a unit.
  const representativeSlots: ILPSlot[] = [];
  const pairedSlot = new Map<number, ILPSlot>();
  for (const s of slots) {
    if (s.compound && s.compoundPairId !== undefined) {
      if (s.id > s.compoundPairId) continue;
      const mate = slots.find(p => p.id === s.compoundPairId);
      if (mate) pairedSlot.set(s.id, mate);
    }
    representativeSlots.push(s);
  }

  representativeSlots.sort((a, b) => {
    const needA = Math.max(0, a.target - a.existingFill);
    const needB = Math.max(0, b.target - b.existingFill);
    const critA = needA * dayWeight(a.dow);
    const critB = needB * dayWeight(b.dow);
    if (critA !== critB) return critB - critA;
    // Tiebreak: earlier date first, then lower slot id for stability.
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id - b.id;
  });

  // Per-worker state.
  type AssignedSlot = { date: string; startTime: string; endTime: string };
  const plannedHoursByWorker = new Map<string, number>();
  const plannedHoursByWorkerWeek = new Map<string, number[]>();
  const plannedSlotsByWorker = new Map<string, AssignedSlot[]>();
  const lastAssignedIdx = new Map<string, number>();

  const numWeeks = multiWeek?.numWeeks ?? 1;
  for (const w of workers) {
    plannedHoursByWorker.set(w.id, 0);
    if (multiWeek) plannedHoursByWorkerWeek.set(w.id, new Array(numWeeks).fill(0));
    plannedSlotsByWorker.set(w.id, []);
  }

  const assignments: ILPResult["assignments"] = [];
  // Workers blocked by the 48h hard cap on slots that ended up unfilled.
  // Key = workerId, value = max excess (hours over cap) across affected slots.
  // Only populated when the cap is the binding reason (earlier filters cleared).
  const capBlockedExcessByWorker = new Map<string, number>();
  let iter = 0;

  function totalForWorker(w: ILPWorker, week: number | undefined, hours: number): number {
    if (multiWeek) {
      const arr = plannedHoursByWorkerWeek.get(w.id)!;
      const existing = multiWeek.existingHoursByWeek.get(w.id)?.[week ?? 0] ?? 0;
      return arr[week ?? 0] + existing + hours;
    }
    return (plannedHoursByWorker.get(w.id) ?? 0) + w.existingWeeklyHours + hours;
  }

  function overlapsAnyPlanned(workerId: string, date: string, startTime: string, endTime: string): boolean {
    const bookings = plannedSlotsByWorker.get(workerId);
    if (!bookings) return false;
    for (const b of bookings) {
      if (b.date !== date) continue;
      if (timesOverlap(b.startTime, b.endTime, startTime, endTime)) return true;
    }
    return false;
  }

  function overlapsExisting(w: ILPWorker, date: string, startTime: string, endTime: string): boolean {
    const existing = w.existingServicesByDate.get(date);
    if (!existing) return false;
    return existing.some(e => timesOverlap(e.startTime, e.endTime, startTime, endTime));
  }

  function commitSlot(w: ILPWorker, slot: ILPSlot): void {
    const fit = pickBestSubRoleMatch(slot, w);
    assignments.push({ workerId: w.id, workerName: w.name, slotId: slot.id, filledAs: fit.filledAs, crossFilled: fit.crossFilled });
    const bookings = plannedSlotsByWorker.get(w.id)!;
    bookings.push({ date: slot.date, startTime: slot.startTime, endTime: slot.endTime });
    plannedHoursByWorker.set(w.id, (plannedHoursByWorker.get(w.id) ?? 0) + slot.hours);
    if (multiWeek) {
      const arr = plannedHoursByWorkerWeek.get(w.id)!;
      arr[slot.week ?? 0] += slot.hours;
    }
    lastAssignedIdx.set(w.id, ++iter);
  }

  for (const slot of representativeSlots) {
    const need = Math.max(0, slot.target - slot.existingFill);
    if (need <= 0) continue;
    const mate = pairedSlot.get(slot.id);

    // Candidate pool: same role, available, no pre-existing overlap, no in-pass overlap,
    // and weekly cap not exceeded (including the mate if compound).
    const totalHoursForCommit = slot.hours + (mate?.hours ?? 0);
    const preCap = workers
      .filter(w => w.role === slot.role)
      .filter(w => checker.isAvailable(w.id, slot) && (!mate || checker.isAvailable(w.id, mate)))
      .filter(w => !overlapsExisting(w, slot.date, slot.startTime, slot.endTime))
      .filter(w => !overlapsAnyPlanned(w.id, slot.date, slot.startTime, slot.endTime))
      .filter(w => !mate || (!overlapsExisting(w, mate.date, mate.startTime, mate.endTime)
        && !overlapsAnyPlanned(w.id, mate.date, mate.startTime, mate.endTime)));
    const candidates = preCap.filter(w => totalForWorker(w, slot.week, totalHoursForCommit) <= weeklyCap);

    if (candidates.length === 0) {
      // If the cap is the binding reason (earlier filters left at least one candidate
      // that only got cut by the 48h check), record the excess per worker.
      for (const w of preCap) {
        const total = totalForWorker(w, slot.week, totalHoursForCommit);
        const excess = total - weeklyCap;
        if (excess <= 0) continue;
        const prev = capBlockedExcessByWorker.get(w.id) ?? 0;
        if (excess > prev) capBlockedExcessByWorker.set(w.id, excess);
      }
      continue;
    }

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aHoursDone = plannedHoursByWorker.get(a.id) ?? 0;
      const bHoursDone = plannedHoursByWorker.get(b.id) ?? 0;
      const aRemain = (a.contractHours ?? 0) - (aHoursDone + a.existingWeeklyHours);
      const bRemain = (b.contractHours ?? 0) - (bHoursDone + b.existingWeeklyHours);
      if (aRemain !== bRemain) return bRemain - aRemain;
      const aLast = lastAssignedIdx.get(a.id) ?? 0;
      const bLast = lastAssignedIdx.get(b.id) ?? 0;
      return aLast - bLast;
    });

    const toAssign = Math.min(need, candidates.length);
    for (let i = 0; i < toAssign; i++) {
      const w = candidates[i];
      commitSlot(w, slot);
      if (mate) commitSlot(w, mate);
    }
  }

  // Multi-week: reconstruct perWeekWorkerHours from assignments so downstream
  // code (multi-week-solver, tier-2 warnings) sees the greedy plan correctly.
  let perWeekWorkerHours: Map<string, number[]> | undefined;
  let perWeekWorkerServices: Map<string, number[]> | undefined;
  if (multiWeek) {
    perWeekWorkerHours = new Map();
    perWeekWorkerServices = new Map();
    for (const a of assignments) {
      const s = slots.find(x => x.id === a.slotId);
      if (!s) continue;
      if (!perWeekWorkerHours.has(a.workerId)) perWeekWorkerHours.set(a.workerId, new Array(numWeeks).fill(0));
      if (!perWeekWorkerServices.has(a.workerId)) perWeekWorkerServices.set(a.workerId, new Array(numWeeks).fill(0));
      perWeekWorkerHours.get(a.workerId)![s.week ?? 0] += s.hours;
      perWeekWorkerServices.get(a.workerId)![s.week ?? 0] += 1;
    }
  }

  const unfilledSlots = computeUnfilledSlots(slots, assignments);
  const complianceWarnings = computeComplianceWarnings(workers, slots, config, assignments, multiWeek, perWeekWorkerHours);
  for (const [workerId, excess] of capBlockedExcessByWorker) {
    complianceWarnings.push({
      workerId,
      rule: weeklyCap > GREEDY_HARD_CAP ? "GREEDY_60H_CAP" : "GREEDY_48H_CAP",
      excessHours: Math.round(excess * 100) / 100,
    });
  }

  return {
    status: "feasible",
    assignments,
    solveTimeMs: performance.now() - startTime,
    stats: { variables: 0, constraints: 0, workers: workers.length, slots: slots.length },
    perWeekWorkerHours,
    perWeekWorkerServices,
    solveTier,
    degraded: true,
    unfilledSlots,
    complianceWarnings,
    relaxations,
  };
}

/**
 * Primary entry point for tiered solves. Replaces direct `solveWithFallback` calls
 * for routes that want graceful degradation on infeasibility.
 *
 * `maxTier` is clamped by `SOLVER_MAX_TIER` env. Preview should pass 1;
 * generate may pass 4 to enable the exceptional 60h crisis pass.
 */
export async function solveWithTiers(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  checker: AvailabilityChecker,
  multiWeek?: MultiWeekConfig,
  slotFillFloors?: SlotFillFloors,
  weights: WeightConfig = DEFAULT_WEIGHTS,
  maxTier: number = 1,
  hints?: HintAssignment[],
  dowTemplates?: Map<string, Set<number>>,
): Promise<ILPResult> {
  const ceiling = Math.min(maxTier, envMaxTier());

  // ── Tier 0 ──
  const tier0 = await tierSolvers.solve(workers, slots, config, checker, multiWeek, slotFillFloors, weights, hints, dowTemplates);
  if (feasible(tier0)) {
    const unfilledSlots = computeUnfilledSlots(slots, tier0.assignments);
    if (unfilledSlots.length === 0) return { ...tier0, solveTier: 0 };
    if (ceiling < 1) return { ...tier0, solveTier: 0, unfilledSlots };
    console.warn(`[solver-tiers] Tier 0 ${tier0.status} but ${unfilledSlots.length} slot(s) underfilled; retrying with Tier 1 (soft slot floors)`);
  } else {
    if (ceiling < 1) return { ...tier0, solveTier: 0 };
    console.warn(`[solver-tiers] Tier 0 ${tier0.status}; retrying with Tier 1 (soft slot floors)`);
  }

  // ── Tier 1: soft slot-fill floors ──
  const targetFillFloors = buildTargetFillFloors(slots, slotFillFloors);
  const tier1Config: ILPConfig = { ...config, softSlotPenalty: M_SLOT };
  const tier1 = await tierSolvers.solve(workers, slots, tier1Config, checker, multiWeek, targetFillFloors, weights, hints, dowTemplates);
  if (feasible(tier1)) {
    const unfilledSlots = computeUnfilledSlots(slots, tier1.assignments);
    if (unfilledSlots.length === 0 || ceiling < 2) {
      return {
        ...tier1,
        solveTier: 1,
        unfilledSlots,
        relaxations: ["soft-slot-floors"],
      };
    }
    console.warn(`[solver-tiers] Tier 1 ${tier1.status} but ${unfilledSlots.length} slot(s) underfilled; retrying with Tier 2 (soft OT + bypass C7/C8)`);
  } else {
    if (ceiling < 2) return { ...tier1, solveTier: 1 };
    console.warn(`[solver-tiers] Tier 1 ${tier1.status}; retrying with Tier 2 (soft OT + bypass C7/C8)`);
  }

  // ── Tier 2: soft C5 + auto-bypass C7/C8 ──
  const bypassedRules = new Set(config.disabledRules);
  const newlyBypassedRules = ["HCR-L3132-1", "HCR-L3132-2"].filter(rule => !bypassedRules.has(rule));
  for (const rule of ["HCR-L3132-1", "HCR-L3132-2"]) bypassedRules.add(rule);
  const tier2Config: ILPConfig = {
    ...config,
    softSlotPenalty: M_SLOT,
    softC5Penalty: M_C5,
    softC5ExtraHours: C5_EXTRA_HOURS,
    disabledRules: bypassedRules,
  };
  const tier2 = await tierSolvers.solve(workers, slots, tier2Config, checker, multiWeek, targetFillFloors, weights, hints, dowTemplates);
  if (feasible(tier2)) {
    const unfilledSlots = computeUnfilledSlots(slots, tier2.assignments);
    const complianceWarnings = [
      ...computeComplianceWarnings(workers, slots, config, tier2.assignments, multiWeek, tier2.perWeekWorkerHours),
      ...computeBypassedRestWarnings(workers, slots, config, tier2.assignments)
        .filter(w => newlyBypassedRules.includes(w.rule)),
    ];
    if (unfilledSlots.length === 0 || ceiling < 3) {
      return {
        ...tier2,
        solveTier: 2,
        unfilledSlots,
        complianceWarnings,
        relaxations: ["soft-slot-floors", "soft-ot-cap", "bypass-C7", "bypass-C8"],
      };
    }
    console.warn(`[solver-tiers] Tier 2 ${tier2.status} but ${unfilledSlots.length} slot(s) underfilled; falling through to Tier 3 (greedy)`);
  } else {
    if (ceiling < 3) return { ...tier2, solveTier: 2 };
    console.warn(`[solver-tiers] Tier 2 ${tier2.status}; falling through to Tier 3 (greedy)`);
  }

  // ── Tier 3: greedy ──
  const tier3 = greedyFallback(workers, slots, config, checker, multiWeek);
  const tier3Unfilled = tier3.unfilledSlots ?? computeUnfilledSlots(slots, tier3.assignments);
  if (tier3Unfilled.length === 0 || ceiling < 4) return tier3;

  console.warn(`[solver-tiers] Tier 3 greedy left ${tier3Unfilled.length} slot(s) underfilled; retrying with Tier 4 (exceptional 60h cap)`);
  return greedyFallback(
    workers,
    slots,
    config,
    checker,
    multiWeek,
    EXCEPTIONAL_WEEKLY_CAP,
    4,
    ["greedy-fallback", "exceptional-60h-cap"],
  );
}
