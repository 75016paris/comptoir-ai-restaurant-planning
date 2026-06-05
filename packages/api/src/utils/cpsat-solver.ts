/**
 * CP-SAT solver for autostaffing — primary backend.
 *
 * Mirrors the ILP model from ilp-solver.ts but solves via Google OR-Tools
 * CP-SAT (Python sidecar at packages/api/solver/cpsat_server.py, dabke JSON
 * protocol). Same decision variables, constraints, and weighted-sum objective
 * as the ILP path, so results are comparable. ILP is the fallback only.
 *
 * Why CP-SAT wins for this problem: stronger constraint propagation on boolean
 * assignment variables, cleaner infeasibility diagnosis, and an idiomatic
 * `at_most_one` for shift overlap and rest windows (see ./solver-circuit.ts
 * for transport, ./solver-fallback.ts for ILP fallback on unreachability).
 *
 * Warm-start: multi-week-solver passes the previous successful assignment
 * list as `hints`. Translated here to `{varName: 1}` and sent as
 * `options.solutionHints`. `repairHint` is opt-in via `CPSAT_REPAIR_HINT=1`:
 * OR-Tools' repair mechanism only triggers in multi-worker mode via a race
 * between workers (Perron, or-tools#3277) and was measured to regress the
 * économique preset in the 2026-04-24 cross-preset sweep. With repair off,
 * CP-SAT treats the hint as a starting point it is free to improve on.
 *
 * Objective: weighted sum with separated magnitudes. Reference patterns for
 * lexicographic passes and soft sequence constraints are tracked in the
 * internal decision notes.
 */

import { timeToMinutes, timesOverlap, parseDateUTC, fmtDateUTC } from "./scheduling.js";
import { pickBestSubRoleMatch, type ILPWorker, type ILPSlot, type ILPConfig, type ILPResult, type AvailabilityChecker, type MultiWeekConfig, type SlotFillFloors } from "./ilp-solver.js";
import type { SolverRequest, SolverResponse } from "dabke";
import { DEFAULT_WEIGHTS, type WeightConfig, hasChefLabel, subRoleSubstitution } from "@comptoir/shared";
import { callSolverWithRetry } from "./solver-circuit.js";
import { costCoeff } from "./solver-cost.js";
import { slotKey, type HintAssignment } from "../services/hint-store.js";
import { roundAwayFromZero } from "./cpsat-rounding.js";
import {
  c9FreshnessGateEnabled,
  c9GateDecision,
  type C9Confidence,
} from "./c9-freshness.js";

// Local types matching dabke's internal solver protocol
type SolverTerm = { var: string; coeff: number };
type SolverVariable = 
  | { type: "bool"; name: string }
  | { type: "int"; name: string; min: number; max: number }
  | { type: "interval"; name: string; start: number; end: number; size: number; presenceVar?: string };
type SolverConstraint =
  | { type: "linear"; terms: SolverTerm[]; op: "<=" | ">=" | "=="; rhs: number }
  | { type: "soft_linear"; terms: SolverTerm[]; op: "<=" | ">="; rhs: number; penalty: number; id?: string }
  | { type: "at_most_one"; vars: string[] }
  | { type: "exactly_one"; vars: string[] }
  | { type: "implication"; if: string; then: string }
  | { type: "bool_or"; vars: string[] }
  | { type: "bool_and"; vars: string[] }
  | { type: "no_overlap"; intervals: string[] };

// ── Solver client ──
// URL resolution + retry + per-URL circuit breaker live in ./solver-circuit.ts.
// See `callSolverWithRetry` for retry/backoff/4xx-vs-5xx semantics.

// ── Helpers ──

function nextDate(dateStr: string): string {
  const d = parseDateUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return fmtDateUTC(d);
}

function prevDateStr(dateStr: string): string {
  const d = parseDateUTC(dateStr);
  d.setUTCDate(d.getUTCDate() - 1);
  return fmtDateUTC(d);
}

function endMinuteOnServiceDate(startTime: string, endTime: string): number {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end < start) end += 24 * 60;
  return end;
}

function amplitudeMinutes(services: Array<{ startTime: string; endTime: string }>): number {
  if (services.length === 0) return 0;
  const firstStart = Math.min(...services.map(s => timeToMinutes(s.startTime)));
  const lastEnd = Math.max(...services.map(s => endMinuteOnServiceDate(s.startTime, s.endTime)));
  return lastEnd - firstStart;
}

// HCR convention role-specific daily limits
const HCR_DAILY_HOURS_KITCHEN_CHEF = 11;
const HCR_DAILY_HOURS_SALLE = 11.5;
const HCR_DAILY_HOURS_OTHER = 11;
const HCR_MAX_AMPLITUDE_MINUTES = 13 * 60;
const HCR_MAX_WEEKLY_HOURS = 48;

function rawWeeklyCap(w: ILPWorker, config: ILPConfig): number {
  const effectiveOtCap = w.otCap ?? config.otCap;
  if (w.contractHours != null && w.contractHours === 0 && w.contractType === "extra") return effectiveOtCap;
  if (w.contractHours != null && w.contractHours === 0) return 0;
  if (w.contractHours != null) return Math.max(w.contractHours, effectiveOtCap);
  return effectiveOtCap;
}

function hardLegalWeeklyCap(w: ILPWorker): number {
  return w.contractHours != null && w.contractHours === 0 && w.contractType !== "extra" ? 0 : HCR_MAX_WEEKLY_HOURS;
}

// ── Interchangeability fingerprint (audit M7) ──
// Two workers are interchangeable when exchanging them in any feasible solution
// preserves both feasibility and the objective value. That requires equality
// on every field the model reads, plus availability-cell and prefersSlot
// agreement across the planning window. The fingerprint is a deterministic
// string hash over those fields; workers with matching fingerprints form one
// symmetry class. Ordering is canonicalized (sorted keys, sorted sub-role
// lists, etc.) so JS iteration order does not leak into the hash.
function canonMapStr(m: Map<string, number>): string {
  const keys = [...m.keys()].sort();
  return keys.map(k => `${k}=${m.get(k)}`).join(",");
}
function canonServicesByDate(m: Map<string, Array<{ startTime: string; endTime: string }>>): string {
  const keys = [...m.keys()].sort();
  return keys.map(k => {
    const arr = [...(m.get(k) ?? [])].sort((a, b) =>
      a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1
      : a.endTime < b.endTime ? -1 : a.endTime > b.endTime ? 1 : 0);
    return `${k}:${arr.map(x => `${x.startTime}-${x.endTime}`).join("|")}`;
  }).join(",");
}
function workerInterchangeabilityFingerprint(
  w: ILPWorker,
  slots: ILPSlot[],
  checker: AvailabilityChecker,
): string {
  const parts: string[] = [
    `r=${w.role}`,
    `sr=${[...w.subRoles].sort().join("+")}`,
    `ct=${w.contractType ?? "null"}`,
    `ch=${w.contractHours}`,
    `ow=${w.overtimeWilling ? 1 : 0}`,
    `pr=${w.priority}`,
    `oc=${w.otCap ?? "null"}`,
    `hh=${w.historicalHours}`,
    `hw=${w.historicalWeeks}`,
    `fl=${w.flexibility}`,
    `hr=${w.hourlyRateCents ?? "null"}`,
    `lu=${w.leaveUrgency ?? "null"}`,
    `mr=${w.multiRestaurantWilling ? 1 : 0}`,
    `sf=${w.sharedFromRestaurantId ?? "null"}`,
    `pp=${w.assignmentPoolPenalty ?? 0}`,
    `bc=${w.bootstrapC9 ? 1 : 0}`,
    `ewh=${w.existingWeeklyHours}`,
    `ewd=${[...w.existingWorkDates].sort().join(",")}`,
    `edh=${canonMapStr(w.existingDailyHours)}`,
    `ele=${canonMapStr(w.existingLastEnd)}`,
    `efs=${canonMapStr(w.existingFirstStart)}`,
    `esb=${canonServicesByDate(w.existingServicesByDate)}`,
    `c=${canonMapStr(w.consistency)}`,
  ];
  const sortedSlots = [...slots].sort((a, b) => a.id - b.id);
  parts.push(`av=${sortedSlots.map(s => checker.isAvailable(w.id, s) ? 1 : 0).join("")}`);
  const dz = new Set<string>();
  for (const s of slots) dz.add(`${s.dow}\u0000${s.zone}`);
  const dzSorted = [...dz].sort();
  parts.push(`pf=${dzSorted.map(k => {
    const i = k.indexOf("\u0000");
    return checker.prefersSlot(w.id, Number(k.substring(0, i)), k.substring(i + 1)) ? 1 : 0;
  }).join("")}`);
  return parts.join("|");
}

// ── Main solver ──

function dynamicCpsatOptions(workersCount: number, slotsCount: number, numWeeks: number): { timeLimitSeconds: number; numWorkers: number } {
  const complexity = workersCount * slotsCount;
  const timeLimitSeconds =
    complexity >= 18_000 || numWeeks >= 9 ? 20 :
    complexity >= 8_000 || numWeeks >= 6 ? 12 :
    complexity < 1_000 && numWeeks === 1 ? 3 :
    8;
  // The production VPS has 4 vCPU. Cap default search workers at 3 so one CPU
  // remains available for API/web/WhatsApp while large analyses solve.
  const numWorkers =
    complexity >= 18_000 || numWeeks >= 9 ? 3 :
    complexity >= 8_000 || numWeeks >= 6 ? 2 :
    1;
  return { timeLimitSeconds, numWorkers };
}

export async function solveCPSAT(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  checker: AvailabilityChecker,
  multiWeek?: MultiWeekConfig,
  slotFillFloors?: SlotFillFloors,
  weights: WeightConfig = DEFAULT_WEIGHTS,
  hints?: HintAssignment[],
  // Per-worker dow template (Set<0..6>). When `weights.templateMatch > 0` and
  // the template for a worker contains a slot's dow, the var gets a
  // `+templateMatch × SCALE` objective bump. Production caller (multi-week-
  // solver) passes undefined until DB plumbing lands (§6.3 reference patterns);
  // harness supplies this from the cold-pass assignments for measurement.
  dowTemplates?: Map<string, Set<number>>,
): Promise<ILPResult> {
  const startTime = performance.now();

  // Multi-week arrays must be exactly `numWeeks` long so the C4/C5/C9 loops
  // can index by week without silent `?? 0` defaults masking a caller bug.
  // Padding is the orchestrator's (multi-week-solver) responsibility; the
  // builder enforces the invariant loudly.
  if (multiWeek) {
    for (const [id, arr] of multiWeek.c9BaseWeeks) {
      if (arr.length !== multiWeek.numWeeks) throw new Error(`c9BaseWeeks for worker ${id} has length ${arr.length}, expected ${multiWeek.numWeeks}`);
    }
    for (const [id, arr] of multiWeek.c9BaseHours) {
      if (arr.length !== multiWeek.numWeeks) throw new Error(`c9BaseHours for worker ${id} has length ${arr.length}, expected ${multiWeek.numWeeks}`);
    }
    for (const [id, arr] of multiWeek.existingHoursByWeek) {
      if (arr.length !== multiWeek.numWeeks) throw new Error(`existingHoursByWeek for worker ${id} has length ${arr.length}, expected ${multiWeek.numWeeks}`);
    }
  }

  // Structured infeasibility short-circuits. Checked in precedence order so
  // callers get the most specific cause (e.g. empty workers is reported as
  // "no-workers", not the downstream consequence "no-eligible-pairs").
  if (workers.length === 0) {
    return {
      status: "infeasible", reason: "no-workers", assignments: [],
      solveTimeMs: performance.now() - startTime,
      stats: { variables: 0, constraints: 0, workers: 0, slots: slots.length },
    };
  }
  if (slots.length === 0) {
    return {
      status: "infeasible", reason: "no-slots", assignments: [],
      solveTimeMs: performance.now() - startTime,
      stats: { variables: 0, constraints: 0, workers: workers.length, slots: 0 },
    };
  }

  // C9 freshness-gate diagnostics — populated alongside C9 constraint emission below.
  const c9ConfidenceOut: Record<string, C9Confidence> = {};
  const c9SkippedOut: string[] = [];
  const c9GateByWorker = new Map<string, ReturnType<typeof c9GateDecision>>();
  const c9GateEnabled = c9FreshnessGateEnabled();
  for (const w of workers) {
    const decision = c9GateDecision({
      weeksWithData: w.historicalWeeks,
      bootstrap: !!w.bootstrapC9,
      enabled: c9GateEnabled,
    });
    c9ConfidenceOut[w.id] = decision.confidence;
    if (!decision.apply) c9SkippedOut.push(w.id);
    c9GateByWorker.set(w.id, decision);
  }

  // ═══════════════════════════════════════════════════
  // Step 1: Pre-filter feasible (worker, slot) pairs
  // ═══════════════════════════════════════════════════

  type VarInfo = { worker: ILPWorker; slot: ILPSlot; varName: string; idx: number };
  const vars: VarInfo[] = [];
  const varsByWorker = new Map<string, VarInfo[]>();
  const varsBySlot = new Map<number, VarInfo[]>();
  const varsByWorkerDate = new Map<string, VarInfo[]>();

  for (const w of workers) {
    for (const s of slots) {
      if (w.role !== s.role) continue;
      if (!checker.isAvailable(w.id, s)) continue;
      const existing = w.existingServicesByDate.get(s.date);
      if (existing?.some(e => timesOverlap(e.startTime, e.endTime, s.startTime, s.endTime))) continue;

      const varName = `x_${vars.length}`;
      const info: VarInfo = { worker: w, slot: s, varName, idx: vars.length };
      vars.push(info);

      if (!varsByWorker.has(w.id)) varsByWorker.set(w.id, []);
      varsByWorker.get(w.id)!.push(info);
      if (!varsBySlot.has(s.id)) varsBySlot.set(s.id, []);
      varsBySlot.get(s.id)!.push(info);
      const wdKey = `${w.id}_${s.date}`;
      if (!varsByWorkerDate.has(wdKey)) varsByWorkerDate.set(wdKey, []);
      varsByWorkerDate.get(wdKey)!.push(info);
    }
  }

  const varsByWorkerWeek = new Map<string, VarInfo[]>();
  if (multiWeek) {
    for (const v of vars) {
      const wk = v.slot.week ?? 0;
      const key = `${v.worker.id}_${wk}`;
      if (!varsByWorkerWeek.has(key)) varsByWorkerWeek.set(key, []);
      varsByWorkerWeek.get(key)!.push(v);
    }
  }

  if (vars.length === 0) {
    return {
      status: "infeasible", reason: "no-eligible-pairs", assignments: [],
      solveTimeMs: performance.now() - startTime,
      stats: { variables: 0, constraints: 0, workers: workers.length, slots: slots.length },
    };
  }

  // ═══════════════════════════════════════════════════
  // Step 2: Build CP-SAT model
  // ═══════════════════════════════════════════════════

  const solverVars: SolverVariable[] = [];
  const constraints: SolverConstraint[] = [];
  const objTerms: SolverTerm[] = [];

  // Assignment variables (boolean)
  for (const v of vars) {
    solverVars.push({ type: "bool" as const, name: v.varName });
  }

  // Objective weights (shared with ILP via WeightConfig). Calibration sweeps override these.
  const FILL_WEIGHT = weights.fill;
  const BUCKET0_VALUE = weights.bucket0Value;
  const BUCKET1_VALUE = weights.bucket1Value;
  const BUCKET2_PENALTY = weights.bucket2Penalty;
  const BUCKET3_PENALTY = weights.bucket3Penalty;
  const BUCKET2_OT_OFFSET = weights.bucket2OtOffset;
  const BUCKET3_OT_OFFSET = weights.bucket3OtOffset;
  const CONSISTENCY_WEIGHT = weights.consistency;
  const PREF_WEIGHT = weights.preference;
  const PRIORITY_WEIGHT = weights.priority;
  const FLEXIBILITY_WEIGHT = weights.flexibility;
  const SUBROLE_MISMATCH_PENALTY = weights.subroleMismatch;
  const ROLE_PENALTY = weights.rolePenalty;
  const COST_AWARENESS_WEIGHT = weights.costAwareness;
  const LEAVE_CONSERVATION_WEIGHT = weights.leaveConservation;
  const REDUNDANCY_WEIGHT = weights.redundancy;
  const TEMPLATE_MATCH_WEIGHT = weights.templateMatch;
  const CONTRACT_COMPLETION_WEIGHT = weights.contractCompletion;
  const TITULAIRE_BONUS = weights.titulaireBonus;
  const titulaireKeys = config.preferredAssignmentKeys ?? new Set<string>();

  // Per-worker pre-assignment deficit fraction (contract - existing hours, normalized).
  // Used by the contractCompletion objective term so workers far below contract are
  // more attractive than workers near or above contract.
  const deficitFractionByWorker = new Map<string, number>();
  for (const w of workers) {
    if (!w.contractHours || w.contractHours <= 0) { deficitFractionByWorker.set(w.id, 0); continue; }
    let existing = 0;
    if (multiWeek) {
      const arr = multiWeek.existingHoursByWeek.get(w.id);
      if (arr) existing = arr.reduce((a, b) => a + b, 0) / arr.length;
    }
    const deficit = Math.max(0, w.contractHours - existing);
    deficitFractionByWorker.set(w.id, deficit / w.contractHours);
  }
  const templateMatchActive = TEMPLATE_MATCH_WEIGHT > 0 && !!dowTemplates && dowTemplates.size > 0;

  const otDist = config.otDistribution;

  // ── Piecewise-linear hour buckets ──
  // CP-SAT uses int vars, so we scale hours to minutes for precision
  const SCALE = 60; // minutes per hour — all hour values multiplied by this

  type BucketVar = { varName: string; coeff: number; upperBound: number };
  const workerBuckets = new Map<string, BucketVar[]>();
  const workerWeekBuckets = multiWeek ? new Map<string, BucketVar[]>() : null;
  let auxIdx = 0;

  const makeBuckets = (w: ILPWorker, existingHours: number): BucketVar[] => {
    const contract = w.contractHours;
    const deficit = Math.max(0, contract - existingHours);
    const b0Cap = deficit;
    const b1Cap = Math.max(0, contract * 0.15);
    const b2Cap = Math.max(0, contract * 0.15);
    const buckets: BucketVar[] = [];

    if (b0Cap > 0) {
      buckets.push({ varName: `b0_${auxIdx++}`, coeff: Math.round(BUCKET0_VALUE * 100) / 100, upperBound: Math.round(b0Cap * SCALE) });
    }

    let otMult: number;
    if (otDist === "by-priority") {
      const prioFactor = Math.max(0.1, 1.0 - (w.priority - 1) * 0.1);
      otMult = prioFactor + (w.overtimeWilling ? 0.30 : 0);
    } else if (otDist === "even") {
      otMult = 0.4;
    } else {
      const prioFactor = Math.max(0.1, 1.0 - (w.priority - 1) * 0.1);
      otMult = w.overtimeWilling ? 1.0 : prioFactor * 0.3;
    }

    if (b1Cap > 0) {
      buckets.push({ varName: `b1_${auxIdx++}`, coeff: Math.round(BUCKET1_VALUE * otMult * 100) / 100, upperBound: Math.round(b1Cap * SCALE) });
    }
    if (b2Cap > 0) {
      buckets.push({ varName: `b2_${auxIdx++}`, coeff: -Math.round(BUCKET2_PENALTY * Math.max(0, 1.0 - otMult * BUCKET2_OT_OFFSET) * 100) / 100, upperBound: Math.round(b2Cap * SCALE) });
    }
    buckets.push({ varName: `b3_${auxIdx++}`, coeff: -Math.round(BUCKET3_PENALTY * Math.max(0, 1.0 - otMult * BUCKET3_OT_OFFSET) * 100) / 100, upperBound: 200 * SCALE });

    return buckets;
  };

  if (multiWeek) {
    for (const w of workers) {
      for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
        const wkKey = `${w.id}_${wk}`;
        const wkVars = varsByWorkerWeek.get(wkKey);
        if (!wkVars || wkVars.length === 0) continue;
        const existing = multiWeek.existingHoursByWeek.get(w.id)?.[wk] ?? 0;
        workerWeekBuckets!.set(wkKey, makeBuckets(w, existing));
      }
    }
  } else {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars || wVars.length === 0) continue;
      workerBuckets.set(w.id, makeBuckets(w, w.existingWeeklyHours));
    }
  }

  // Register bucket variables as int vars
  const allBucketMap = multiWeek && workerWeekBuckets ? workerWeekBuckets : workerBuckets;
  for (const [, buckets] of allBucketMap) {
    for (const b of buckets) {
      solverVars.push({ type: "int" as const, name: b.varName, min: 0, max: b.upperBound });
    }
  }

  // ── Per-assignment objective terms ──
  for (const v of vars) {
    let coeff = FILL_WEIGHT;
    const slotType = v.slot.startTime < "16:00" ? "midi" : "soir";
    const consistKey = `${v.slot.dow}_${v.slot.role}_${slotType}`;
    coeff += CONSISTENCY_WEIGHT * (v.worker.consistency.get(consistKey) || 0);
    if (checker.prefersSlot(v.worker.id, v.slot.dow, v.slot.zone)) coeff += PREF_WEIGHT;
    const prioWeight = otDist === "by-priority" ? PRIORITY_WEIGHT * 3 : PRIORITY_WEIGHT;
    coeff += prioWeight * Math.max(0, 10 - v.worker.priority);
    if (v.worker.flexibility > 0 && v.worker.flexibility < 20) {
      coeff += FLEXIBILITY_WEIGHT * (20 - v.worker.flexibility);
    }
    if (v.slot.roleBreakdown && v.worker.subRoles.length > 0) {
      // Per-substitution penalty: 0 (exact) / 5 (lateral) / 15 (small) / 40 (heavy / downgrade).
      // We pick the BEST match across the slot's required sub-roles for this worker.
      let bestPenalty = Infinity;
      for (const subRole of Object.keys(v.slot.roleBreakdown)) {
        const m = subRoleSubstitution(subRole, v.worker.subRoles);
        if (m.eligible && m.penalty < bestPenalty) bestPenalty = m.penalty;
      }
      if (bestPenalty === Infinity) {
        // No eligible sub-role match at all — full mismatch penalty (keeps prior strict mode).
        coeff -= SUBROLE_MISMATCH_PENALTY;
      } else if (bestPenalty > 0) {
        // Cross-fill / lateral substitution — soft penalty proportional to mismatch tier.
        coeff -= SUBROLE_MISMATCH_PENALTY * (bestPenalty / 40);
      }
    }
    coeff += costCoeff(v.worker, v.slot.hours, COST_AWARENESS_WEIGHT);
    if (CONTRACT_COMPLETION_WEIGHT > 0) {
      coeff += CONTRACT_COMPLETION_WEIGHT * (deficitFractionByWorker.get(v.worker.id) ?? 0);
    }
    if (LEAVE_CONSERVATION_WEIGHT > 0 && v.worker.leaveUrgency && v.worker.leaveUrgency > 0) {
      coeff -= LEAVE_CONSERVATION_WEIGHT * v.slot.hours * v.worker.leaveUrgency;
    }
    if (templateMatchActive) {
      const tpl = dowTemplates!.get(v.worker.id);
      if (tpl && tpl.has(v.slot.dow)) coeff += TEMPLATE_MATCH_WEIGHT;
    }
    if (TITULAIRE_BONUS > 0 && titulaireKeys.has(`${v.worker.id}_${v.slot.dow}_${v.slot.zone}_${v.slot.role}`)) {
      coeff += TITULAIRE_BONUS;
    }
    coeff -= v.worker.assignmentPoolPenalty ?? 0;
    objTerms.push({ var: v.varName, coeff: roundAwayFromZero(coeff * SCALE) });
  }

  // Per-bucket objective terms. CP-SAT requires integer coefficients — under
  // otDistribution="by-priority" the pre-rounding otMult produces fractional
  // bucket coeffs (e.g. 10 × 1.15 = 11.5) which the sidecar cannot accept.
  // ILP rounds identically for parity. Bucket vars are in minutes so the
  // effective per-minute weight is coeff/60 of the per-hour bucket value.
  for (const [, buckets] of allBucketMap) {
    for (const b of buckets) {
      objTerms.push({ var: b.varName, coeff: roundAwayFromZero(b.coeff) });
    }
  }

  // ═══════════════════════════════════════════════════
  // Step 3: Build constraints
  // ═══════════════════════════════════════════════════

  // C0: Bucket-linking — total assigned hours (in minutes) = sum of buckets
  if (multiWeek && workerWeekBuckets) {
    for (const w of workers) {
      for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
        const wkKey = `${w.id}_${wk}`;
        const wkVars = varsByWorkerWeek.get(wkKey);
        const buckets = workerWeekBuckets.get(wkKey);
        if (!wkVars || !buckets || wkVars.length === 0) continue;
        const terms: SolverTerm[] = wkVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) }));
        for (const b of buckets) terms.push({ var: b.varName, coeff: -1 });
        constraints.push({ type: "linear" as const, terms, op: "==" as const, rhs: 0 });
      }
    }
  } else {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      const buckets = workerBuckets.get(w.id);
      if (!wVars || !buckets || wVars.length === 0) continue;
      const terms: SolverTerm[] = wVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) }));
      for (const b of buckets) terms.push({ var: b.varName, coeff: -1 });
      constraints.push({ type: "linear" as const, terms, op: "==" as const, rhs: 0 });
    }
  }

  // C1: Slot capacity
  for (const s of slots) {
    const slotVars = varsBySlot.get(s.id);
    if (!slotVars || slotVars.length === 0) continue;
    const remaining = Math.max(0, s.target - s.existingFill);
    const terms: SolverTerm[] = slotVars.map(v => ({ var: v.varName, coeff: 1 }));
    constraints.push({ type: "linear" as const, terms, op: "<=" as const, rhs: remaining });
  }

  // C1b: Slot fill floors (training scenario protection).
  // When `config.softSlotPenalty` is set (Tier 1+), the floor becomes a soft `>=`
  // handled by the sidecar's soft_linear constraint type.
  if (slotFillFloors && slotFillFloors.size > 0) {
    const slotGroups = new Map<string, ILPSlot[]>();
    for (const s of slots) {
      if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) continue;
      const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
      const group = slotGroups.get(key);
      if (group) group.push(s);
      else slotGroups.set(key, [s]);
    }
    for (const [key, groupSlots] of slotGroups) {
      const floor = slotFillFloors.get(key);
      if (floor === undefined || floor <= 0) continue;
      const totalExistingFill = groupSlots.reduce((sum, s) => sum + s.existingFill, 0);
      const needed = floor - totalExistingFill;
      if (needed <= 0) continue;
      const groupVars = groupSlots.flatMap(s => varsBySlot.get(s.id) ?? []);
      if (groupVars.length === 0) continue;
      const terms = groupVars.map(v => ({ var: v.varName, coeff: 1 }));
      if (config.softSlotPenalty && config.softSlotPenalty > 0) {
        constraints.push({
          type: "soft_linear" as const,
          terms,
          op: ">=" as const, rhs: needed,
          penalty: config.softSlotPenalty,
          id: `floor_${key}`,
        });
      } else {
        constraints.push({ type: "linear" as const, terms, op: ">=" as const, rhs: needed });
      }
    }
  }

  // C2: Compound pairing
  const compoundPairs = new Map<string, { slotA: ILPSlot; slotB: ILPSlot }>();
  for (const s of slots) {
    if (s.compound && s.compoundPairId !== undefined) {
      const key = [Math.min(s.id, s.compoundPairId), Math.max(s.id, s.compoundPairId)].join("_");
      if (!compoundPairs.has(key)) {
        const paired = slots.find(p => p.id === s.compoundPairId);
        if (paired) compoundPairs.set(key, { slotA: s, slotB: paired });
      }
    }
  }
  for (const [, pair] of compoundPairs) {
    for (const w of workers) {
      const varA = vars.find(v => v.worker.id === w.id && v.slot.id === pair.slotA.id);
      const varB = vars.find(v => v.worker.id === w.id && v.slot.id === pair.slotB.id);
      if (varA && varB) {
        constraints.push({ type: "linear" as const, terms: [{ var: varA.varName, coeff: 1 }, { var: varB.varName, coeff: -1 }], op: "==" as const, rhs: 0 });
      } else if (varA && !varB) {
        constraints.push({ type: "linear" as const, terms: [{ var: varA.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
      } else if (!varA && varB) {
        constraints.push({ type: "linear" as const, terms: [{ var: varB.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
      }
    }
  }

  // C3: No time overlap (audit M8)
  // Encoding: one optional `interval` var per assignment var (presence = x_*),
  // then a single `no_overlap` per (worker, date) group. Overnight slots
  // (endTime < startTime) split into two intervals on the 0..1440 minute line
  // sharing the same presence var, preserving the `timesOverlap` overnight
  // semantic. Compound siblings are included unconditionally (option b): split
  // shifts are non-overlapping by domain definition, and the C2 equality
  // (`varA == varB` at line 487) keeps them co-assigned so no_overlap never
  // separates them.
  for (const [, wdVars] of varsByWorkerDate) {
    if (wdVars.length < 2) continue;
    const intervals: string[] = [];
    for (const wd of wdVars) {
      const sMin = timeToMinutes(wd.slot.startTime);
      const eMin = timeToMinutes(wd.slot.endTime);
      if (eMin > sMin) {
        const ivName = `iv_${wd.varName}`;
        solverVars.push({
          type: "interval" as const,
          name: ivName,
          start: sMin,
          end: eMin,
          size: eMin - sMin,
          presenceVar: wd.varName,
        });
        intervals.push(ivName);
      } else {
        // Overnight: [sMin, 1440) ∪ [0, eMin). Same presence var on both.
        if (sMin < 1440) {
          const ivA = `iv_${wd.varName}_a`;
          solverVars.push({
            type: "interval" as const,
            name: ivA,
            start: sMin,
            end: 1440,
            size: 1440 - sMin,
            presenceVar: wd.varName,
          });
          intervals.push(ivA);
        }
        if (eMin > 0) {
          const ivB = `iv_${wd.varName}_b`;
          solverVars.push({
            type: "interval" as const,
            name: ivB,
            start: 0,
            end: eMin,
            size: eMin,
            presenceVar: wd.varName,
          });
          intervals.push(ivB);
        }
      }
    }
    if (intervals.length >= 2) {
      constraints.push({ type: "no_overlap" as const, intervals });
    }
  }

  // C3b: Max daily amplitude (HCR-L3121-34)
  // Allows real coupures/split shifts, but only when the span from first start
  // to last end on the same day is ≤13h. This is separate from C4: e.g.
  // 10:00-15:30 + 18:00-23:30 is 11h worked (OK for floor) but 13.5h
  // amplitude (not OK). Include existing services so manual/planned work also
  // bounds what the solver can add.
  if (!config.disabledRules.has("HCR-L3121-34")) {
    for (const [, wdVars] of varsByWorkerDate) {
      if (wdVars.length === 0) continue;
      const worker = wdVars[0].worker;
      const date = wdVars[0].slot.date;
      const existing = worker.existingServicesByDate.get(date) ?? [];

      if (existing.length > 0) {
        for (const v of wdVars) {
          const span = amplitudeMinutes([...existing, { startTime: v.slot.startTime, endTime: v.slot.endTime }]);
          if (span > HCR_MAX_AMPLITUDE_MINUTES) {
            constraints.push({ type: "linear" as const, terms: [{ var: v.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
          }
        }
      }

      for (let i = 0; i < wdVars.length; i++) {
        for (let j = i + 1; j < wdVars.length; j++) {
          const a = wdVars[i];
          const b = wdVars[j];
          const span = amplitudeMinutes([
            { startTime: a.slot.startTime, endTime: a.slot.endTime },
            { startTime: b.slot.startTime, endTime: b.slot.endTime },
          ]);
          if (span > HCR_MAX_AMPLITUDE_MINUTES) {
            constraints.push({ type: "at_most_one" as const, vars: [a.varName, b.varName] });
          }
        }
      }
    }
  }

  // C4: Max daily hours
  if (!config.disabledRules.has("HCR-L3121-18")) {
    for (const [wdKey, wdVars] of varsByWorkerDate) {
      const [workerId, date] = splitKey(wdKey);
      const w = workers.find(w => w.id === workerId)!;
      const existingDaily = w.existingDailyHours.get(date) || 0;
      const hasCompound = wdVars.some(v => v.slot.compound);
      const roleMaxDaily = w.role === "kitchen" && hasChefLabel(w.subRoles) ? HCR_DAILY_HOURS_KITCHEN_CHEF
        : w.role === "floor" ? HCR_DAILY_HOURS_SALLE : HCR_DAILY_HOURS_OTHER;
      const maxDaily = hasCompound ? config.maxDailyHoursCompound : roleMaxDaily;
      const remainingMinutes = Math.round((maxDaily - existingDaily) * SCALE);

      if (remainingMinutes <= 0) {
        for (const v of wdVars) {
          constraints.push({ type: "linear" as const, terms: [{ var: v.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
        }
      } else if (wdVars.length > 1) {
        constraints.push({
          type: "linear" as const,
          terms: wdVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
          op: "<=" as const, rhs: remainingMinutes,
        });
      }
    }
  }

  // C5: Weekly hours cap.
  // The HCR 48h legal maximum is always a hard cap. Tier 2 can only soften a
  // tighter personal/controlled cap below 48h.
  //
  // `softC5Penalty` is per-hour by contract (see ILPConfig.softC5Penalty JSDoc
  // and the ILP implementation, which expresses C5 terms in hours). CP-SAT's
  // C5 expression and slack are in minutes (coeff = slot.hours × SCALE, rhs in
  // minutes), so we divide the per-hour penalty by SCALE when emitting the
  // soft_linear payload. Without this conversion the penalty is applied
  // per-minute and one hour of violation costs 60× the documented intent —
  // dominating M_SLOT and other soft terms to the point that Tier 2's C5
  // softening effectively behaves like a hard cap. (Audit finding H6.)
  const softC5Extra = config.softC5ExtraHours ?? 2;
  const softC5Enabled = !!(config.softC5Penalty && config.softC5Penalty > 0);
  const softC5PenaltyPerMinute = softC5Enabled
    ? Math.max(1, Math.round(config.softC5Penalty! / SCALE))
    : 0;
  if (multiWeek) {
    for (const w of workers) {
      const personalCap = rawWeeklyCap(w, config);
      const legalCap = hardLegalWeeklyCap(w);
      for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
        const wkKey = `${w.id}_${wk}`;
        const wkVars = varsByWorkerWeek.get(wkKey);
        if (!wkVars || wkVars.length === 0) continue;
        const existingWk = multiWeek.existingHoursByWeek.get(w.id)?.[wk] ?? 0;
        const hardRemainingMinutes = Math.round((legalCap - existingWk) * SCALE);
        if (hardRemainingMinutes <= 0) {
          for (const v of wkVars) constraints.push({ type: "linear" as const, terms: [{ var: v.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
        } else {
          constraints.push({
            type: "linear" as const,
            terms: wkVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
            op: "<=" as const, rhs: hardRemainingMinutes,
          });
        }
        if (softC5Enabled && personalCap > 0 && personalCap < legalCap && hardRemainingMinutes > 0) {
          const rhsMinutes = Math.round(Math.max(0, personalCap - existingWk + softC5Extra) * SCALE);
          constraints.push({
            type: "soft_linear" as const,
            terms: wkVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
            op: "<=" as const, rhs: rhsMinutes,
            penalty: softC5PenaltyPerMinute,
            id: `c5_${w.id}_${wk}`,
          });
        }
      }
    }
  } else {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars || wVars.length === 0) continue;
      const personalCap = rawWeeklyCap(w, config);
      const legalCap = hardLegalWeeklyCap(w);
      const hardRemainingMinutes = Math.round((legalCap - w.existingWeeklyHours) * SCALE);
      if (hardRemainingMinutes <= 0) {
        for (const v of wVars) constraints.push({ type: "linear" as const, terms: [{ var: v.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
      } else {
        constraints.push({
          type: "linear" as const,
          terms: wVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
          op: "<=" as const, rhs: hardRemainingMinutes,
        });
      }
      if (softC5Enabled && personalCap > 0 && personalCap < legalCap && hardRemainingMinutes > 0) {
        const rhsMinutes = Math.round(Math.max(0, personalCap - w.existingWeeklyHours + softC5Extra) * SCALE);
        constraints.push({
          type: "soft_linear" as const,
          terms: wVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
          op: "<=" as const, rhs: rhsMinutes,
          penalty: softC5PenaltyPerMinute,
          id: `c5_${w.id}`,
        });
      }
    }
  }

  // C6: Min rest between shifts (10h)
  if (!config.disabledRules.has("HCR-L3131-1")) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars) continue;
      const byDate = new Map<string, VarInfo[]>();
      for (const v of wVars) {
        if (!byDate.has(v.slot.date)) byDate.set(v.slot.date, []);
        byDate.get(v.slot.date)!.push(v);
      }
      const sortedDates = [...byDate.keys()].sort();
      for (const dateA of sortedDates) {
        const dateB = nextDate(dateA);
        const varsA = byDate.get(dateA) || [];
        const varsB = byDate.get(dateB) || [];

        for (const va of varsA) {
          let endMin = timeToMinutes(va.slot.endTime);
          if (endMin < timeToMinutes(va.slot.startTime)) endMin += 24 * 60;
          const toMidnight = (24 * 60) - endMin;

          const nextFirstStart = w.existingFirstStart.get(dateB);
          if (nextFirstStart !== undefined) {
            const restHours = (toMidnight + nextFirstStart) / 60;
            if (restHours < config.minRestHours) {
              constraints.push({ type: "linear" as const, terms: [{ var: va.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
              continue;
            }
          }

          for (const vb of varsB) {
            const fromMidnight = timeToMinutes(vb.slot.startTime);
            const restHours = (toMidnight + fromMidnight) / 60;
            if (restHours < config.minRestHours) {
              constraints.push({ type: "at_most_one" as const, vars: [va.varName, vb.varName] });
            }
          }
        }

        const prevDate = prevDateStr(dateA);
        const prevEnd = w.existingLastEnd.get(prevDate);
        if (prevEnd !== undefined) {
          const toMidnight = (24 * 60) - prevEnd;
          for (const va of varsA) {
            const fromMidnight = timeToMinutes(va.slot.startTime);
            const restHours = (toMidnight + fromMidnight) / 60;
            if (restHours < config.minRestHours) {
              constraints.push({ type: "linear" as const, terms: [{ var: va.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
            }
          }
        }
      }
    }
  }

  // ── Date indicator variables ──
  type DateIndicator = { varName: string; workerId: string; date: string };
  const dateIndicatorVars: DateIndicator[] = [];
  const dateIndicatorMap = new Map<string, Map<string, string>>();
  const needC7 = !config.disabledRules.has("HCR-L3132-1");
  const needC8 = !config.disabledRules.has("HCR-L3132-2");
  const needRedundancy = REDUNDANCY_WEIGHT > 0;

  if (needC7 || needC8 || needRedundancy) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars || wVars.length === 0) continue;
      const varsByDate = new Map<string, VarInfo[]>();
      for (const v of wVars) {
        if (!varsByDate.has(v.slot.date)) varsByDate.set(v.slot.date, []);
        varsByDate.get(v.slot.date)!.push(v);
      }
      const workerIndicators = new Map<string, string>();
      for (const [date, dVars] of varsByDate) {
        if (w.existingWorkDates.has(date)) continue;
        const yName = `y_${auxIdx++}`;
        dateIndicatorVars.push({ varName: yName, workerId: w.id, date });
        workerIndicators.set(date, yName);
        solverVars.push({ type: "bool" as const, name: yName });

        // y >= x for each slot
        for (const v of dVars) {
          constraints.push({ type: "linear" as const, terms: [{ var: yName, coeff: 1 }, { var: v.varName, coeff: -1 }], op: ">=" as const, rhs: 0 });
        }
        // y <= sum(x)
        const terms: SolverTerm[] = [{ var: yName, coeff: 1 }];
        for (const v of dVars) terms.push({ var: v.varName, coeff: -1 });
        constraints.push({ type: "linear" as const, terms, op: "<=" as const, rhs: 0 });

        // Redundancy (backup reservation): per-day penalty proportional to the
        // number of slots on this date the worker is eligible for. Versatile
        // workers (high N) are held in reserve so replacement candidates stay
        // free when someone calls out.
        if (needRedundancy) {
          const N = dVars.length;
          const coeff = -Math.round(REDUNDANCY_WEIGHT * N);
          if (coeff !== 0) objTerms.push({ var: yName, coeff });
        }
      }
      dateIndicatorMap.set(w.id, workerIndicators);
    }
  }

  // C7: Max consecutive days (6)
  if (needC7) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars) continue;
      const indicators = dateIndicatorMap.get(w.id) || new Map<string, string>();
      const datesWithVars = new Set<string>();
      for (const v of wVars) datesWithVars.add(v.slot.date);
      const sortedDates = [...datesWithVars].sort();
      if (sortedDates.length === 0) continue;

      const emittedWindows = new Set<string>();
      for (const pivotDate of sortedDates) {
        for (let offset = -6; offset <= 0; offset++) {
          const windowStart = parseDateUTC(pivotDate);
          windowStart.setUTCDate(windowStart.getUTCDate() + offset);
          const windowKey = fmtDateUTC(windowStart);
          if (emittedWindows.has(windowKey)) continue;
          emittedWindows.add(windowKey);

          const windowDates: string[] = [];
          const d = new Date(windowStart);
          for (let i = 0; i < 7; i++) { windowDates.push(fmtDateUTC(d)); d.setUTCDate(d.getUTCDate() + 1); }

          let existingCount = 0;
          const indicatorTerms: string[] = [];
          for (const wd of windowDates) {
            const yVar = indicators.get(wd);
            if (w.existingWorkDates.has(wd)) existingCount++;
            else if (yVar) indicatorTerms.push(yVar);
          }
          if (indicatorTerms.length === 0) continue;
          const rhs = config.maxConsecutiveDays - existingCount;
          if (rhs <= 0) {
            for (const t of indicatorTerms) constraints.push({ type: "linear" as const, terms: [{ var: t, coeff: 1 }], op: "==" as const, rhs: 0 });
          } else if (indicatorTerms.length > rhs) {
            constraints.push({ type: "linear" as const, terms: indicatorTerms.map(t => ({ var: t, coeff: 1 })), op: "<=" as const, rhs });
          }
        }
      }
    }
  }

  // C8: Rolling rest — max 5 work days in any 7-day window
  if (needC8) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars) continue;
      const indicators = dateIndicatorMap.get(w.id) || new Map<string, string>();
      const datesWithVars = new Set<string>();
      for (const v of wVars) datesWithVars.add(v.slot.date);
      const sortedDates = [...datesWithVars].sort();
      if (sortedDates.length === 0) continue;

      const emittedWindows = new Set<string>();
      for (const pivotDate of sortedDates) {
        for (let offset = -6; offset <= 0; offset++) {
          const windowStart = parseDateUTC(pivotDate);
          windowStart.setUTCDate(windowStart.getUTCDate() + offset);
          const windowKey = fmtDateUTC(windowStart);
          if (emittedWindows.has(windowKey)) continue;
          emittedWindows.add(windowKey);

          const windowDates: string[] = [];
          const d = new Date(windowStart);
          for (let i = 0; i < 7; i++) { windowDates.push(fmtDateUTC(d)); d.setUTCDate(d.getUTCDate() + 1); }

          let existingCount = 0;
          const indicatorTerms: string[] = [];
          for (const wd of windowDates) {
            const yVar = indicators.get(wd);
            if (w.existingWorkDates.has(wd)) existingCount++;
            else if (yVar) indicatorTerms.push(yVar);
          }
          if (indicatorTerms.length === 0) continue;
          const rhs = config.maxRollingWorkDays - existingCount;
          if (rhs <= 0) {
            for (const t of indicatorTerms) constraints.push({ type: "linear" as const, terms: [{ var: t, coeff: 1 }], op: "==" as const, rhs: 0 });
          } else if (indicatorTerms.length > rhs) {
            constraints.push({ type: "linear" as const, terms: indicatorTerms.map(t => ({ var: t, coeff: 1 })), op: "<=" as const, rhs });
          }
        }
      }
    }
  }

  // C9: 12-week rolling average (46h). See c9-freshness.ts for the gate: low
  // confidence widens the cap 10 %; none/bootstrap skips the constraint entirely.
  // The gate is the single source of truth — no secondary re-gating on raw
  // `historicalWeeks` thresholds (that would shadow the confidence bucket the
  // gate already chose, silently disabling C9 for low-confidence workers).
  if (!config.disabledRules.has("HCR-L3121-22")) {
    if (multiWeek) {
      for (const w of workers) {
        const decision = c9GateByWorker.get(w.id)!;
        if (!decision.apply) continue;
        const maxTotalMinutes = Math.round(config.max12WeekAvgHours * 12 * decision.capMultiplier * SCALE);
        const baseHoursArr = multiWeek.c9BaseHours.get(w.id);
        const existingHoursArr = multiWeek.existingHoursByWeek.get(w.id);
        for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
          const baseHours = baseHoursArr?.[wk] ?? 0;
          let existingInWindow = 0;
          for (let j = Math.max(0, wk - 11); j <= wk; j++) {
            existingInWindow += existingHoursArr?.[j] ?? 0;
          }
          const remainingMinutes = maxTotalMinutes - Math.round((baseHours + existingInWindow) * SCALE);
          const windowVars: VarInfo[] = [];
          for (let j = Math.max(0, wk - 11); j <= wk; j++) {
            const jVars = varsByWorkerWeek.get(`${w.id}_${j}`);
            if (jVars) windowVars.push(...jVars);
          }
          if (windowVars.length === 0) continue;
          if (remainingMinutes <= 0) {
            for (const v of windowVars) constraints.push({ type: "linear" as const, terms: [{ var: v.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
          } else {
            constraints.push({
              type: "linear" as const,
              terms: windowVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
              op: "<=" as const, rhs: remainingMinutes,
            });
          }
        }
      }
    } else {
      for (const w of workers) {
        const decision = c9GateByWorker.get(w.id)!;
        if (!decision.apply) continue;
        const wVars = varsByWorker.get(w.id);
        if (!wVars || wVars.length === 0) continue;
        const maxTotalMinutes = Math.round(config.max12WeekAvgHours * 12 * decision.capMultiplier * SCALE);
        const alreadyUsedMinutes = Math.round((w.historicalHours + w.existingWeeklyHours) * SCALE);
        const remainingMinutes = maxTotalMinutes - alreadyUsedMinutes;
        if (remainingMinutes <= 0) {
          for (const v of wVars) constraints.push({ type: "linear" as const, terms: [{ var: v.varName, coeff: 1 }], op: "==" as const, rhs: 0 });
        } else {
          constraints.push({
            type: "linear" as const,
            terms: wVars.map(v => ({ var: v.varName, coeff: Math.round(v.slot.hours * SCALE) })),
            op: "<=" as const, rhs: remainingMinutes,
          });
        }
      }
    }
  }

  // C10: Role-based staffing (soft constraints)
  const roleRequirementReductions: NonNullable<ILPResult["roleRequirementReductions"]> = [];
  {
    for (const slot of slots) {
      if (!slot.roleBreakdown || Object.keys(slot.roleBreakdown).length === 0) continue;
      if (slot.compound && slot.compoundPairId !== undefined && slot.id > slot.compoundPairId) continue;
      const slotVars = varsBySlot.get(slot.id) || [];
      for (const [subRole, needed] of Object.entries(slot.roleBreakdown)) {
        if (needed <= 0) continue;
        const cappedNeeded = Math.min(needed, Math.max(0, slot.target - slot.existingFill));
        if (cappedNeeded < needed) {
          roleRequirementReductions.push({
            slotId: slot.id, subRole, requested: needed, capped: cappedNeeded,
            reason: "slot-capacity",
          });
        }
        // Eligibility now via subRoleSubstitution (exact + lateral + small/heavy fallback).
        // The per-assignment objective above prices the fit; here we just gate which
        // workers count toward the soft >= breakdown constraint.
        const allEligible = slotVars.filter(v => subRoleSubstitution(subRole, v.worker.subRoles).eligible);
        if (allEligible.length > 0 && cappedNeeded > 0) {
          constraints.push({
            type: "soft_linear" as const,
            terms: allEligible.map(v => ({ var: v.varName, coeff: 1 })),
            op: ">=" as const, rhs: cappedNeeded, penalty: ROLE_PENALTY,
            id: `role_${slot.id}_${subRole}`,
          });
        }
      }
    }
  }

  // ── Symmetry breaking on interchangeable workers (audit M7) ──
  // When two workers share the same canonical fingerprint (see
  // `workerInterchangeabilityFingerprint`), every feasible solution has a
  // permuted twin where the pair is exchanged — the solver wastes branches
  // exploring both halves. For each equivalence class of size ≥ 2, sort by id
  // ascending and emit a "used-monotone" lex-leader via per-worker indicators:
  //   u_i = 1 iff worker i has any assignment          (2 channelling linears
  //                                                     per worker: u >= x_s
  //                                                     for each eligible s,
  //                                                     and u <= sum_s x_s)
  //   u_i >= u_{i+1} for each adjacent pair            (1 lex linear per pair)
  // Krupke/Perron cite this as the single largest CP-SAT win for shift
  // scheduling. In production the equivalence class is usually size 1 (this
  // block is a no-op); the lever fires when a restaurant has multiple new
  // hires with no history at the same role and contract.
  // Gated by `CPSAT_SYMMETRY_BREAK` (default on, set "0" to disable for A/B).
  if (process.env.CPSAT_SYMMETRY_BREAK !== "0") {
    const fpGroups = new Map<string, ILPWorker[]>();
    for (const w of workers) {
      const fp = workerInterchangeabilityFingerprint(w, slots, checker);
      const bucket = fpGroups.get(fp);
      if (bucket) bucket.push(w);
      else fpGroups.set(fp, [w]);
    }
    for (const group of fpGroups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const usedNames: string[] = [];
      for (const w of sorted) {
        const wVars = varsByWorker.get(w.id);
        if (!wVars || wVars.length === 0) { usedNames.push(""); continue; }
        const uName = `u_${auxIdx++}`;
        solverVars.push({ type: "bool" as const, name: uName });
        usedNames.push(uName);
        for (const v of wVars) {
          constraints.push({
            type: "linear" as const,
            terms: [{ var: uName, coeff: 1 }, { var: v.varName, coeff: -1 }],
            op: ">=" as const, rhs: 0,
          });
        }
        const sumTerms: SolverTerm[] = [{ var: uName, coeff: 1 }];
        for (const v of wVars) sumTerms.push({ var: v.varName, coeff: -1 });
        constraints.push({ type: "linear" as const, terms: sumTerms, op: "<=" as const, rhs: 0 });
      }
      for (let i = 0; i < usedNames.length - 1; i++) {
        const a = usedNames[i];
        const b = usedNames[i + 1];
        if (!a || !b) continue;
        constraints.push({
          type: "linear" as const,
          terms: [{ var: a, coeff: 1 }, { var: b, coeff: -1 }],
          op: ">=" as const, rhs: 0,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Step 4: Solve via CP-SAT backend
  // ═══════════════════════════════════════════════════

  // Warm-start hints: translate the caller-supplied (workerId, slotKey) pairs
  // to `{varName: 1}`. Slot keys from a stale model (eligibility drift between
  // the source solve and this one) silently miss the lookup — the sidecar
  // also ignores unknown names, so the hint degrades partially rather than
  // failing.  dabke's SolverOptions type is narrow; `solutionHints`,
  // `repairHint`, `hintConflictLimit` are sidecar-only extensions that pass
  // through JSON unchanged, so we assemble a loose object and cast.
  const defaults = dynamicCpsatOptions(workers.length, slots.length, multiWeek?.numWeeks ?? 1);
  const timeoutParsed = Number.parseInt(process.env.CPSAT_TIMEOUT ?? "", 10);
  const optionsExt: Record<string, unknown> = {
    timeLimitSeconds: Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? timeoutParsed : defaults.timeLimitSeconds,
  };
  const seedParsed = Number.parseInt(process.env.CPSAT_RANDOM_SEED ?? "", 10);
  if (Number.isFinite(seedParsed)) optionsExt.randomSeed = seedParsed;
  if (process.env.CPSAT_NUM_WORKERS === undefined || process.env.CPSAT_NUM_WORKERS === "") {
    optionsExt.numWorkers = defaults.numWorkers;
  } else {
    const workersParsed = Number.parseInt(process.env.CPSAT_NUM_WORKERS, 10);
    if (Number.isFinite(workersParsed) && workersParsed > 0) optionsExt.numWorkers = workersParsed;
  }
  if (hints && hints.length > 0) {
    const varByWorkerSlotKey = new Map<string, string>();
    for (const v of vars) {
      varByWorkerSlotKey.set(`${v.worker.id}|${slotKey(v.slot)}`, v.varName);
    }
    const solutionHints: Record<string, number> = {};
    const hintedVars = new Set<string>();
    let matched = 0;
    for (const h of hints) {
      const name = varByWorkerSlotKey.get(`${h.workerId}|${h.slotKey}`);
      if (name === undefined) continue;
      solutionHints[name] = 1;
      hintedVars.add(name);
      matched++;
    }
    if (matched > 0) {
      for (const v of vars) {
        if (!hintedVars.has(v.varName)) solutionHints[v.varName] = 0;
      }
      optionsExt.solutionHints = solutionHints;
      // `repairHint` is an unreliable mechanism (race-dependent, multi-worker
      // only — per Perron, or-tools#3277) and measured as a regression driver
      // on économique. Default off; `CPSAT_REPAIR_HINT=1` re-enables it for
      // A/B testing or rollback.
      if (process.env.CPSAT_REPAIR_HINT === "1") {
        optionsExt.repairHint = true;
        optionsExt.hintConflictLimit = 50;
      }
    }
  }

  const request: SolverRequest = {
    variables: solverVars,
    constraints,
    objective: { sense: "maximize" as const, terms: objTerms },
    options: optionsExt as SolverRequest["options"],
  };

  let response: SolverResponse;
  try {
    response = await callSolverWithRetry(request);
  } catch (e: any) {
    // Propagate both error classes unchanged.
    //   - CPSATBadModelError (4xx) — our bug. Must escape the fallback wrapper
    //     (ILP would fail identically on a malformed model) and surface as a
    //     5xx so operators see the real reason instead of a silently degraded
    //     greedy result. See audit H5 for the failure mode.
    //   - Network / 5xx / timeout / parse after retries → CPSATUnreachableError.
    //     solveWithFallback catches this one and routes to ILP.
    console.error("[cp-sat] solve failed:", e?.message || e);
    throw e;
  }

  const solveTimeMs = performance.now() - startTime;

  // ═══════════════════════════════════════════════════
  // Step 5: Extract solution
  // ═══════════════════════════════════════════════════

  const status = response.status === "OPTIMAL" ? "optimal"
    : response.status === "FEASIBLE" ? "feasible"
    : response.status === "INFEASIBLE" ? "infeasible"
    : "error";

  const assignments: ILPResult["assignments"] = [];
  let perWeekWorkerHours: Map<string, number[]> | undefined;
  let perWeekWorkerServices: Map<string, number[]> | undefined;

  if ((status === "optimal" || status === "feasible") && response.values) {
    for (const v of vars) {
      if (response.values[v.varName] === 1) {
        const fit = pickBestSubRoleMatch(v.slot, v.worker);
        assignments.push({
          workerId: v.worker.id, workerName: v.worker.name, slotId: v.slot.id,
          filledAs: fit.filledAs, crossFilled: fit.crossFilled,
        });
      }
    }

    if (multiWeek) {
      perWeekWorkerHours = new Map();
      perWeekWorkerServices = new Map();
      for (const v of vars) {
        if (response.values![v.varName] === 1) {
          const wk = v.slot.week ?? 0;
          const wId = v.worker.id;
          if (!perWeekWorkerHours.has(wId)) perWeekWorkerHours.set(wId, new Array(multiWeek.numWeeks).fill(0));
          if (!perWeekWorkerServices.has(wId)) perWeekWorkerServices.set(wId, new Array(multiWeek.numWeeks).fill(0));
          perWeekWorkerHours.get(wId)![wk] += v.slot.hours;
          perWeekWorkerServices.get(wId)![wk] += 1;
        }
      }
    }
  }

  return {
    status: status as ILPResult["status"],
    reason: status === "infeasible" ? "model-infeasible" : undefined,
    assignments,
    objectiveValue: (response as { objectiveValue?: number }).objectiveValue,
    solveTimeMs,
    stats: {
      variables: solverVars.length,
      constraints: constraints.length,
      workers: workers.length,
      slots: slots.length,
    },
    perWeekWorkerHours,
    perWeekWorkerServices,
    c9Confidence: c9ConfidenceOut,
    c9Skipped: c9SkippedOut,
    roleRequirementReductions: roleRequirementReductions.length ? roleRequirementReductions : undefined,
  };
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf("_");
  return [key.substring(0, i), key.substring(i + 1)];
}
