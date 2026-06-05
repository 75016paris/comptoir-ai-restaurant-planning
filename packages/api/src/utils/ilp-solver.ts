/**
 * ILP (Integer Linear Programming) solver for autostaffing.
 *
 * Translates the staff scheduling problem into a Mixed-Integer Program
 * and solves it with HiGHS (WASM, zero native deps).
 *
 * Decision variables: x_w_s ∈ {0,1} — worker w assigned to slot s.
 * Hard constraints encode all HCR labor law rules.
 * Soft objectives are weighted in the objective function.
 */

import { timeToMinutes, serviceHours as calcServiceHours, timesOverlap, isoDayOfWeek, zoneToAvailSlot, parseDateUTC, fmtDateUTC } from "./scheduling.js";
import { DEFAULT_WEIGHTS, type WeightConfig, hasChefLabel, subRoleSubstitution } from "@comptoir/shared";
import {
  c9FreshnessGateEnabled,
  c9GateDecision,
  type C9Confidence,
} from "./c9-freshness.js";
import { solveInWorker } from "./highs-pool.js";
import { costCoeff } from "./solver-cost.js";

// ── Types expected by the solver ──

export type Role = "kitchen" | "floor";

export interface ILPWorker {
  id: string;
  name: string;
  role: Role;
  priority: number;
  overtimeWilling: boolean;
  contractType?: string | null;
  contractHours: number;
  /** Per-worker weekly hours cap. When set, overrides config.otCap for this worker. Computed upstream as min(workerPreference, adminOverride ?? globalCap). */
  otCap?: number | null;
  subRoles: string[];
  /** Total hours already worked this week (from existing services) */
  existingWeeklyHours: number;
  /** Dates already worked (for consecutive/rolling checks) */
  existingWorkDates: Set<string>;
  /** Per-date existing daily hours */
  existingDailyHours: Map<string, number>;
  /** Per-date last service end (minutes) */
  existingLastEnd: Map<string, number>;
  /** Per-date first service start (minutes) */
  existingFirstStart: Map<string, number>;
  /** Per-date existing service time ranges (for overlap check) */
  existingServicesByDate: Map<string, Array<{ startTime: string; endTime: string }>>;
  /** Historical rolling 12-week hours + week count */
  historicalHours: number;
  historicalWeeks: number;
  /** Worker hire date (YYYY-MM-DD). Preserved for diagnostics; the
   *  solver consumes `bootstrapC9` below rather than recomputing. */
  hireDate?: string | null;
  /** True when the worker was hired inside the 4-week C9 bootstrap window.
   *  Pre-computed upstream against the plan's Monday (see `isBootstrapWorker`).
   *  When true, the freshness gate skips C9 regardless of stored history. */
  bootstrapC9?: boolean;
  /** Consistency scores: "dow_role_slot" -> count */
  consistency: Map<string, number>;
  /** Flexibility: total slots this worker can fill */
  flexibility: number;
  /** Hourly rate in integer cents — consumed by the `costAwareness` weight. */
  hourlyRateCents?: number;
  /** Leave-balance urgency in [0, 1] — consumed by the `leaveConservation` weight.
   *  Higher = worker has many CP days still to take with little time left in the
   *  reference period. Populated from leave-intelligence.computeLeaveUrgency(). */
  leaveUrgency?: number;
  /** True when the employee can also be shared to sibling restaurants. */
  multiRestaurantWilling?: boolean;
  /** Source restaurant id when this worker is present only through a share authorization. */
  sharedFromRestaurantId?: string | null;
  /** Per-assignment reserve penalty. Used to preserve flexible/shared workers unless needed. */
  assignmentPoolPenalty?: number;
}

export interface ILPSlot {
  id: number;
  date: string;
  dow: number;
  zone: string;
  role: Role;
  startTime: string;
  endTime: string;
  hours: number;
  target: number;
  existingFill: number;
  compound: boolean;
  /** For compound slots: the paired slot id (morning ↔ evening) */
  compoundPairId?: number;
  /** Role breakdown requirements if role-based staffing is enabled */
  roleBreakdown?: Record<string, number>;
  /** Week index for multi-week models (0-based) */
  week?: number;
}

// HCR convention role-specific daily hour limits (matching compliance.ts RULES.MAX_DAILY_HOURS)
const HCR_DAILY_HOURS_KITCHEN_CHEF = 11;   // chef de cuisine
const HCR_DAILY_HOURS_SALLE = 11.5;        // serveur (11h30)
const HCR_DAILY_HOURS_OTHER = 11;           // kitchen non-chef (HCR exceptional)
const HCR_MAX_WEEKLY_HOURS = 48;

export interface ILPConfig {
  maxDailyHoursCompound: number;
  minRestHours: number;
  maxConsecutiveDays: number;
  maxRollingWorkDays: number;
  max12WeekAvgHours: number;
  otCap: number;
  disabledRules: Set<string>;
  otDistribution: string;
  dayPriorityMap: Record<string, number>;
  prefEnabled: boolean;
  templates: Array<{ role: string; zone: string; startTime: string; endTime: string }>;
  /** Tier-1 relaxation: when set, C1b slot fill floors become soft with this per-unit penalty. */
  softSlotPenalty?: number;
  /** Tier-2 relaxation: when set, C5 weekly OT cap becomes soft with this per-hour penalty. */
  softC5Penalty?: number;
  /** Tier-2 relaxation: how many hours above cap the C5 slack is allowed to take (default 2). */
  softC5ExtraHours?: number;
  /** Titulaire pinning for the active staffing profile. Each entry encodes a
   *  (workerId, dayOfWeek, zone, role) the admin has flagged as the worker's
   *  regular shift. The bonus fires only on exact-key match against this set
   *  — the key is `${workerId}_${dow}_${zone}_${role}`. Used as a manual seed
   *  for the équipe-stable preset on new restaurants where the consistency
   *  map has no historical data to anchor on. */
  preferredAssignmentKeys?: ReadonlySet<string>;
}

/** Build the per-assignment lookup key the solver uses to match against
 *  ILPConfig.preferredAssignmentKeys. Exported so callers can build the
 *  same Set the solver checks against. */
export function titulaireKey(workerId: string, dow: number, zone: string, role: string): string {
  return `${workerId}_${dow}_${zone}_${role}`;
}

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

/**
 * For a (slot, worker) pair, find the best sub-role match the worker provides for
 * the slot's required breakdown. Returns the chosen sub-role label and whether
 * it's a non-exact substitution (cross-fill). Used both during solving (objective
 * coefficient) and after (assignment metadata for display).
 */
export function pickBestSubRoleMatch(
  slot: ILPSlot,
  worker: { subRoles: readonly string[] },
): { filledAs: string | null; crossFilled: boolean; penalty: number } {
  if (!slot.roleBreakdown || worker.subRoles.length === 0) {
    return { filledAs: null, crossFilled: false, penalty: 0 };
  }
  let best = { filledAs: null as string | null, crossFilled: false, penalty: Infinity };
  for (const subRole of Object.keys(slot.roleBreakdown)) {
    const m = subRoleSubstitution(subRole, worker.subRoles);
    if (m.eligible && m.penalty < best.penalty) {
      best = { filledAs: m.filledAs, crossFilled: !m.exact, penalty: m.penalty };
    }
  }
  if (best.penalty === Infinity) return { filledAs: null, crossFilled: false, penalty: 0 };
  return best;
}

/** Check if a worker is available for a slot (pre-filter — excludes pairs that can never be assigned) */
export interface AvailabilityChecker {
  isAvailable(workerId: string, slot: ILPSlot): boolean;
  prefersSlot(workerId: string, dow: number, zone: string): boolean;
}

export interface ILPResult {
  status: "optimal" | "feasible" | "infeasible" | "timeout" | "error";
  assignments: Array<{ workerId: string; workerName: string; slotId: number; filledAs?: string | null; crossFilled?: boolean }>;
  objectiveValue?: number;
  solveTimeMs: number;
  stats: {
    variables: number;
    constraints: number;
    workers: number;
    slots: number;
  };
  /** Per-worker per-week hours (only in multi-week mode) */
  perWeekWorkerHours?: Map<string, number[]>;
  /** Per-worker per-week service count (only in multi-week mode) */
  perWeekWorkerServices?: Map<string, number[]>;
  /** Which solver produced this result when routed through `solveWithFallback`. */
  solverUsed?: "cpsat" | "ilp-fallback";
  /** Which relaxation tier produced this result (populated by solveWithTiers).
   *  0 = fully-constrained; 1 = soft slot floors; 2 = soft OT cap + bypass C7/C8;
   *  3 = greedy; 4 = exceptional 60h crisis cap. */
  solveTier?: 0 | 1 | 2 | 3 | 4;
  /** Per-slot shortage when the solver couldn't fill target. Populated at Tier 1+. */
  unfilledSlots?: Array<{ slotId: number; shortage: number }>;
  /** Per-worker compliance warnings when a soft constraint was relaxed. Populated at Tier 2+. */
  complianceWarnings?: Array<{ workerId: string; rule: string; excessHours: number }>;
  /** Human-readable list of relaxations applied to reach this result. */
  relaxations?: string[];
  /** Signals greedy fallback output, including the exceptional Tier 4 pass. */
  degraded?: boolean;
  /** C9 freshness confidence per worker, reported for diagnostics. */
  c9Confidence?: Record<string, C9Confidence>;
  /** Workers for which C9 was skipped (bootstrap or insufficient data). */
  c9Skipped?: string[];
  /** Per-slot role-breakdown requirements that were silently reduced because
   *  the subRole count exceeded the slot's remaining capacity (target - existingFill). */
  roleRequirementReductions?: Array<{
    slotId: number;
    subRole: string;
    requested: number;
    capped: number;
    reason: "slot-capacity";
  }>;
  /** Structured infeasibility cause. Set only when `status === "infeasible"`. */
  reason?: "no-workers" | "no-slots" | "no-eligible-pairs" | "model-infeasible";
}

/** Configuration for multi-week simultaneous ILP solve */
export interface MultiWeekConfig {
  /** Number of weeks in the model */
  numWeeks: number;
  /** Per-worker per-week existing hours from DB (index = week number) */
  existingHoursByWeek: Map<string, number[]>;
  /** Per-worker per-week: historical hours outside planning window for C9 rolling average */
  c9BaseHours: Map<string, number[]>;
  /** Per-worker per-week: count of historical weeks with data for C9 threshold */
  c9BaseWeeks: Map<string, number[]>;
}

/**
 * Per-slot-group minimum fill floors.
 * Key: "week_dow_role_zone" (e.g. "0_1_kitchen_Midi"), value: minimum total fill (existing + new).
 * Used to prevent training scenarios from degrading coverage in other roles.
 */
export type SlotFillFloors = Map<string, number>;

/**
 * Build and solve the ILP model.
 *
 * The model has binary variables x_{w,s} for each feasible worker-slot pair.
 * Infeasible pairs (availability, role mismatch, existing overlaps) are excluded
 * at model-build time to keep the model small.
 *
 * **Internal — call {@link ../utils/solver-fallback.solveWithFallback} instead.**
 * Direct use is reserved for:
 *   - the fallback wrapper in `solver-fallback.ts` (on CPSATUnreachableError),
 *   - test files asserting ILP behaviour in isolation,
 *   - calibration tools under `packages/api/tools/`.
 *
 * ILP is feature-frozen per audit restructure step C (2026-04-23). New
 * objective terms and constraints land on CP-SAT only; see
 * `solver-fallback.ts` for the current parity-gap list.
 */
export async function solveILP(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  checker: AvailabilityChecker,
  multiWeek?: MultiWeekConfig,
  slotFillFloors?: SlotFillFloors,
  weights: WeightConfig = DEFAULT_WEIGHTS,
  // HiGHS ILP has no equivalent of AddHint; accept and discard so the
  // signature matches solveCPSAT (used as the shared SolverFn via fallback).
  _hints?: import("../services/hint-store.js").HintAssignment[],
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

  // C9 freshness-gate diagnostics accumulate across the solve and surface in the
  // result. The gate decisions themselves are computed further below.
  const c9ConfidenceOut: Record<string, C9Confidence> = {};
  const c9SkippedOut: string[] = [];
  const c9GateByWorker = new Map<string, ReturnType<typeof c9GateDecision>>();

  // ── Step 1: Pre-filter feasible (worker, slot) pairs ──
  // A pair is feasible if the worker could potentially fill the slot
  // ignoring interactions with other assignments (those become constraints).

  type VarInfo = { worker: ILPWorker; slot: ILPSlot; varName: string; idx: number };
  const vars: VarInfo[] = [];
  const varsByWorker = new Map<string, VarInfo[]>();
  const varsBySlot = new Map<number, VarInfo[]>();
  const varsByWorkerDate = new Map<string, VarInfo[]>();

  for (const w of workers) {
    for (const s of slots) {
      // Role must match
      if (w.role !== s.role) continue;
      // Must be available
      if (!checker.isAvailable(w.id, s)) continue;
      // Must not overlap with existing services
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

  // Multi-week: index vars by worker+week for per-week constraints
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
      status: "infeasible",
      assignments: [],
      solveTimeMs: performance.now() - startTime,
      stats: { variables: 0, constraints: 0, workers: workers.length, slots: slots.length },
    };
  }

  // ── Step 2: Build objective function with piecewise-linear hour buckets ──
  //
  // For fair distribution, we use auxiliary continuous variables to model
  // diminishing returns per worker. Each worker's total new hours are split
  // into buckets with decreasing objective value:
  //
  //   b0_w: hours filling contract deficit     (value: +BUCKET0_VALUE per hour)
  //   b1_w: hours at 100-115% of contract      (value: +BUCKET1_VALUE per hour)
  //   b2_w: hours at 115-130% of contract      (value: -BUCKET2_PENALTY per hour)
  //   b3_w: hours above 130% of contract       (value: -BUCKET3_PENALTY per hour)
  //
  // The solver naturally fills b0 first (highest value), then b1, etc.
  // This makes overtime a last resort and spreads work across workers.

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
  const COST_AWARENESS_WEIGHT = weights.costAwareness;
  const LEAVE_CONSERVATION_WEIGHT = weights.leaveConservation;
  const REDUNDANCY_WEIGHT = weights.redundancy;
  const CONTRACT_COMPLETION_WEIGHT = weights.contractCompletion;
  const TITULAIRE_BONUS = weights.titulaireBonus;
  const titulaireKeys = config.preferredAssignmentKeys ?? new Set<string>();

  // Per-worker pre-assignment deficit fraction (contract - existing hours, normalized).
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

  // OT distribution mode affects how overtime hours are distributed across workers.
  // The mode shapes bucket coefficients so the solver naturally routes OT differently:
  //   willing-first: willing workers get significantly reduced OT penalties
  //   by-priority:   P1 workers get best OT terms regardless of willingness
  //   even:          uniform penalties regardless of willingness — spreads OT evenly
  const otDist = config.otDistribution;

  // Auxiliary variables for piecewise hour buckets
  type BucketVar = { varName: string; coeff: number; upperBound: number };
  const workerBuckets = new Map<string, BucketVar[]>();
  const workerWeekBuckets = multiWeek ? new Map<string, BucketVar[]>() : null;
  let auxIdx = 0;

  // Helper: create bucket variables for a worker given existing hours for one week.
  // Bucket coefficients vary by OT distribution mode to steer where overtime lands.
  const makeBuckets = (w: ILPWorker, existingHours: number): BucketVar[] => {
    const contract = w.contractHours;
    const deficit = Math.max(0, contract - existingHours);
    const b0Cap = deficit;
    const b1Cap = Math.max(0, contract * 0.15);
    const b2Cap = Math.max(0, contract * 0.15);
    const buckets: BucketVar[] = [];

    // b0: filling contract deficit — same across all modes (always good)
    if (b0Cap > 0) {
      buckets.push({ varName: `b0_${auxIdx++}`, coeff: BUCKET0_VALUE, upperBound: b0Cap });
    }

    // OT multiplier: controls how much the solver favors/penalizes OT for this worker
    let otMult: number;
    if (otDist === "by-priority") {
      const prioFactor = Math.max(0.1, 1.0 - (w.priority - 1) * 0.1);
      otMult = prioFactor + (w.overtimeWilling ? 0.30 : 0);
    } else if (otDist === "even") {
      otMult = 0.4;
    } else {
      // willing-first (default): willing workers absorb OT first
      const prioFactor = Math.max(0.1, 1.0 - (w.priority - 1) * 0.1);
      otMult = w.overtimeWilling ? 1.0 : prioFactor * 0.3;
    }

    // b1: slight OT (100-115% of contract)
    if (b1Cap > 0) {
      const coeff = BUCKET1_VALUE * otMult;
      buckets.push({ varName: `b1_${auxIdx++}`, coeff, upperBound: b1Cap });
    }
    // b2: moderate OT (115-130%)
    if (b2Cap > 0) {
      const coeff = -BUCKET2_PENALTY * Math.max(0, 1.0 - otMult * BUCKET2_OT_OFFSET);
      buckets.push({ varName: `b2_${auxIdx++}`, coeff, upperBound: b2Cap });
    }
    // b3: heavy OT (>130%)
    {
      const coeff = -BUCKET3_PENALTY * Math.max(0, 1.0 - otMult * BUCKET3_OT_OFFSET);
      buckets.push({ varName: `b3_${auxIdx++}`, coeff, upperBound: 200 });
    }
    return buckets;
  };

  if (multiWeek) {
    // Multi-week: create buckets per worker per week
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
    // Single-week: one set of buckets per worker
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars || wVars.length === 0) continue;
      workerBuckets.set(w.id, makeBuckets(w, w.existingWeeklyHours));
    }
  }

  // Build objective terms
  const objTerms: string[] = [];

  // Per-assignment terms (fill + soft preferences)
  for (const v of vars) {
    let coeff = FILL_WEIGHT;

    // Consistency bonus
    const slotType = v.slot.startTime < "16:00" ? "midi" : "soir";
    const consistKey = `${v.slot.dow}_${v.slot.role}_${slotType}`;
    const consistScore = v.worker.consistency.get(consistKey) || 0;
    coeff += CONSISTENCY_WEIGHT * consistScore;

    // Preference bonus
    if (checker.prefersSlot(v.worker.id, v.slot.dow, v.slot.zone)) {
      coeff += PREF_WEIGHT;
    }

    // Priority bonus — amplified in by-priority mode so high-priority workers
    // are strongly preferred for all assignments (including OT-heavy slots)
    const prioWeight = otDist === "by-priority" ? PRIORITY_WEIGHT * 3 : PRIORITY_WEIGHT;
    coeff += prioWeight * Math.max(0, 10 - v.worker.priority);

    // Flexibility bonus
    if (v.worker.flexibility > 0 && v.worker.flexibility < 20) {
      coeff += FLEXIBILITY_WEIGHT * (20 - v.worker.flexibility);
    }

    // Sub-role substitution: 0 (exact) / 5 (lateral) / 15 (small) / 40 (heavy / downgrade).
    // Pick the BEST match across the slot's required sub-roles for this worker.
    if (v.slot.roleBreakdown && v.worker.subRoles.length > 0) {
      let bestPenalty = Infinity;
      for (const subRole of Object.keys(v.slot.roleBreakdown)) {
        const m = subRoleSubstitution(subRole, v.worker.subRoles);
        if (m.eligible && m.penalty < bestPenalty) bestPenalty = m.penalty;
      }
      if (bestPenalty === Infinity) {
        coeff -= SUBROLE_MISMATCH_PENALTY;
      } else if (bestPenalty > 0) {
        coeff -= SUBROLE_MISMATCH_PENALTY * (bestPenalty / 40);
      }
    }

    coeff += costCoeff(v.worker, v.slot.hours, COST_AWARENESS_WEIGHT);
    if (CONTRACT_COMPLETION_WEIGHT > 0) {
      coeff += CONTRACT_COMPLETION_WEIGHT * (deficitFractionByWorker.get(v.worker.id) ?? 0);
    }

    // Leave-conservation penalty — dissuade assigning workers with urgent CP
    // balance (expiring within 3 months, >10 days unspent). Urgency is in [0,1]
    // so the effective penalty maxes out at LEAVE_CONSERVATION_WEIGHT per slot-hour.
    if (LEAVE_CONSERVATION_WEIGHT > 0 && v.worker.leaveUrgency && v.worker.leaveUrgency > 0) {
      coeff -= LEAVE_CONSERVATION_WEIGHT * v.slot.hours * v.worker.leaveUrgency;
    }

    if (TITULAIRE_BONUS > 0 && titulaireKeys.has(`${v.worker.id}_${v.slot.dow}_${v.slot.zone}_${v.slot.role}`)) {
      coeff += TITULAIRE_BONUS;
    }

    coeff -= v.worker.assignmentPoolPenalty ?? 0;

    coeff = Math.round(coeff * 100) / 100;
    objTerms.push(`+ ${coeff} ${v.varName}`);
  }

  // Per-worker bucket terms (contract balance + OT fairness).
  // Coeffs rounded to integer for parity with CP-SAT (which requires int coeffs).
  const allBucketMap = multiWeek && workerWeekBuckets ? workerWeekBuckets : workerBuckets;
  for (const [, buckets] of allBucketMap) {
    for (const b of buckets) {
      const rounded = Math.round(b.coeff);
      if (rounded === 0) continue;
      const sign = rounded >= 0 ? "+" : "-";
      objTerms.push(`${sign} ${Math.abs(rounded)} ${b.varName}`);
    }
  }

  // Soft constraint penalty terms are appended in Step 3.5 after C10/C11 populate softSlackVars.

  // ── Step 3: Build constraints ──
  const constraints: string[] = [];
  let constraintIdx = 0;

  // C0: Bucket-linking — for each worker (per-week in multi-week mode), total assigned hours = sum of buckets
  if (multiWeek && workerWeekBuckets) {
    for (const w of workers) {
      for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
        const wkKey = `${w.id}_${wk}`;
        const wkVars = varsByWorkerWeek.get(wkKey);
        const buckets = workerWeekBuckets.get(wkKey);
        if (!wkVars || !buckets || wkVars.length === 0) continue;
        const lhs = wkVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
        const rhs = buckets.map(b => b.varName).join(" - ");
        constraints.push(`c${constraintIdx++}: ${lhs} - ${rhs} = 0`);
      }
    }
  } else {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      const buckets = workerBuckets.get(w.id);
      if (!wVars || !buckets || wVars.length === 0) continue;
      const lhs = wVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
      const rhs = buckets.map(b => b.varName).join(" - ");
      constraints.push(`c${constraintIdx++}: ${lhs} - ${rhs} = 0`);
    }
  }

  // C1: Slot capacity — each slot can have at most (target - existingFill) new assignments
  for (const s of slots) {
    const slotVars = varsBySlot.get(s.id);
    if (!slotVars || slotVars.length === 0) continue;
    const remaining = Math.max(0, s.target - s.existingFill);
    if (remaining === 0) {
      // Force all vars to 0
      for (const v of slotVars) {
        constraints.push(`c${constraintIdx++}: ${v.varName} = 0`);
      }
    } else {
      constraints.push(`c${constraintIdx++}: ${slotVars.map(v => v.varName).join(" + ")} <= ${remaining}`);
    }
  }

  // C1b: Slot fill floors — prevent training scenarios from degrading coverage
  // For each (week, dow, role, zone) group, ensure new assignments >= (baseline fill - existing fill).
  // This guarantees subrole training can only add value, never reduce slot coverage.
  // When `config.softSlotPenalty` is set (Tier 1+ relaxation), the floor becomes a soft
  // `>=` via a slack variable penalized in the objective.
  const softFloorSlacks: Array<{ varName: string; penalty: number; upperBound: number; slotId: number }> = [];
  if (slotFillFloors && slotFillFloors.size > 0) {
    // Group slots by (week, dow, role, zone), keeping only the representative slot
    // (for compound pairs, use the lower-ID slot to avoid double-counting)
    const slotGroups = new Map<string, ILPSlot>();
    for (const s of slots) {
      // Skip compound pair's second slot
      if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) continue;
      const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
      const existing = slotGroups.get(key);
      if (!existing || s.existingFill > existing.existingFill) {
        slotGroups.set(key, s);
      }
    }
    for (const [key, repSlot] of slotGroups) {
      const floor = slotFillFloors.get(key);
      if (floor === undefined || floor <= 0) continue;
      const needed = floor - repSlot.existingFill;
      if (needed <= 0) continue;
      // Get assignment vars for this representative slot
      const slotVars = varsBySlot.get(repSlot.id);
      if (!slotVars || slotVars.length === 0) continue;
      if (config.softSlotPenalty && config.softSlotPenalty > 0) {
        const slackName = `uf_${softFloorSlacks.length}`;
        softFloorSlacks.push({ varName: slackName, penalty: config.softSlotPenalty, upperBound: needed, slotId: repSlot.id });
        constraints.push(`c${constraintIdx++}: ${slotVars.map(v => v.varName).join(" + ")} + ${slackName} >= ${needed}`);
      } else {
        constraints.push(`c${constraintIdx++}: ${slotVars.map(v => v.varName).join(" + ")} >= ${needed}`);
      }
    }
  }

  // C2: Compound pairing — if slot A and B are paired, worker must be assigned to both or neither
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
        // x_w_slotA = x_w_slotB (must be assigned together)
        constraints.push(`c${constraintIdx++}: ${varA.varName} - ${varB.varName} = 0`);
      } else if (varA && !varB) {
        // Can't fill B → can't fill A either
        constraints.push(`c${constraintIdx++}: ${varA.varName} = 0`);
      } else if (!varA && varB) {
        constraints.push(`c${constraintIdx++}: ${varB.varName} = 0`);
      }
    }
  }

  // C3: No time overlap — worker can't be assigned to two slots that overlap on the same date
  for (const [wdKey, wdVars] of varsByWorkerDate) {
    for (let i = 0; i < wdVars.length; i++) {
      for (let j = i + 1; j < wdVars.length; j++) {
        const si = wdVars[i].slot;
        const sj = wdVars[j].slot;
        // Skip compound pairs (handled by C2)
        if (si.compound && si.compoundPairId === sj.id) continue;
        if (sj.compound && sj.compoundPairId === si.id) continue;
        if (timesOverlap(si.startTime, si.endTime, sj.startTime, sj.endTime)) {
          constraints.push(`c${constraintIdx++}: ${wdVars[i].varName} + ${wdVars[j].varName} <= 1`);
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

      // Check if any var is for a compound slot
      const hasCompound = wdVars.some(v => v.slot.compound);
      // Role-specific daily limits per HCR convention (L3121-18)
      const roleMaxDaily = w.role === "kitchen" && hasChefLabel(w.subRoles) ? HCR_DAILY_HOURS_KITCHEN_CHEF
        : w.role === "floor" ? HCR_DAILY_HOURS_SALLE
        : HCR_DAILY_HOURS_OTHER;
      const maxDaily = hasCompound ? config.maxDailyHoursCompound : roleMaxDaily;
      const remainingHours = maxDaily - existingDaily;

      if (remainingHours <= 0) {
        for (const v of wdVars) {
          constraints.push(`c${constraintIdx++}: ${v.varName} = 0`);
        }
      } else if (wdVars.length === 1) {
        // Single slot: only emit when the slot alone would exceed the daily budget.
        if (wdVars[0].slot.hours > remainingHours) {
          constraints.push(`c${constraintIdx++}: ${wdVars[0].varName} = 0`);
        }
      } else {
        // Sum of assigned hours ≤ remaining
        const terms = wdVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
        constraints.push(`c${constraintIdx++}: ${terms} <= ${remainingHours}`);
      }
    }
  }

  // C5: Weekly hours cap (OT cap) — per-week in multi-week mode.
  // The HCR 48h legal maximum is always a hard cap. Tier 2 can only soften a
  // tighter personal/controlled cap below 48h.
  const softC5Slacks: Array<{ varName: string; penalty: number; upperBound: number; workerId: string; week?: number }> = [];
  const softC5Extra = config.softC5ExtraHours ?? 2;
  const softC5Enabled = !!(config.softC5Penalty && config.softC5Penalty > 0);
  if (multiWeek) {
    for (const w of workers) {
      const personalCap = rawWeeklyCap(w, config);
      const legalCap = hardLegalWeeklyCap(w);
      for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
        const wkKey = `${w.id}_${wk}`;
        const wkVars = varsByWorkerWeek.get(wkKey);
        if (!wkVars || wkVars.length === 0) continue;
        const existingWk = multiWeek.existingHoursByWeek.get(w.id)?.[wk] ?? 0;
        const terms = wkVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
        const hardRemaining = legalCap - existingWk;
        if (hardRemaining <= 0) {
          for (const v of wkVars) constraints.push(`c${constraintIdx++}: ${v.varName} = 0`);
        } else {
          constraints.push(`c${constraintIdx++}: ${terms} <= ${hardRemaining}`);
        }
        if (softC5Enabled && personalCap > 0 && personalCap < legalCap && hardRemaining > 0) {
          const slackName = `c5_${softC5Slacks.length}`;
          softC5Slacks.push({ varName: slackName, penalty: config.softC5Penalty!, upperBound: softC5Extra, workerId: w.id, week: wk });
          const rhs = Math.max(0, personalCap - existingWk);
          constraints.push(`c${constraintIdx++}: ${terms} - ${slackName} <= ${rhs}`);
        }
      }
    }
  } else {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars || wVars.length === 0) continue;
      const personalCap = rawWeeklyCap(w, config);
      const legalCap = hardLegalWeeklyCap(w);
      const hardRemaining = legalCap - w.existingWeeklyHours;
      const terms = wVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
      if (hardRemaining <= 0) {
        for (const v of wVars) constraints.push(`c${constraintIdx++}: ${v.varName} = 0`);
      } else {
        constraints.push(`c${constraintIdx++}: ${terms} <= ${hardRemaining}`);
      }
      if (softC5Enabled && personalCap > 0 && personalCap < legalCap && hardRemaining > 0) {
        const slackName = `c5_${softC5Slacks.length}`;
        softC5Slacks.push({ varName: slackName, penalty: config.softC5Penalty!, upperBound: softC5Extra, workerId: w.id });
        const rhs = Math.max(0, personalCap - w.existingWeeklyHours);
        constraints.push(`c${constraintIdx++}: ${terms} - ${slackName} <= ${rhs}`);
      }
    }
  }

  // C6: Min rest between shifts (10h)
  if (!config.disabledRules.has("HCR-L3131-1")) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars) continue;

      // Group by date
      const byDate = new Map<string, VarInfo[]>();
      for (const v of wVars) {
        if (!byDate.has(v.slot.date)) byDate.set(v.slot.date, []);
        byDate.get(v.slot.date)!.push(v);
      }

      const sortedDates = [...byDate.keys()].sort();
      for (let di = 0; di < sortedDates.length; di++) {
        const dateA = sortedDates[di];
        // Check rest to next day
        const dateB = nextDate(dateA);
        const varsA = byDate.get(dateA) || [];
        const varsB = byDate.get(dateB) || [];

        // For each pair of (slot on dateA, slot on dateB), check if rest is violated
        for (const va of varsA) {
          let endMin = timeToMinutes(va.slot.endTime);
          if (endMin < timeToMinutes(va.slot.startTime)) endMin += 24 * 60;
          const toMidnight = (24 * 60) - endMin;

          // Check against existing services on next day
          const nextFirstStart = w.existingFirstStart.get(dateB);
          if (nextFirstStart !== undefined) {
            const restHours = (toMidnight + nextFirstStart) / 60;
            if (restHours < config.minRestHours) {
              constraints.push(`c${constraintIdx++}: ${va.varName} = 0`);
              continue;
            }
          }

          // Check against planned slots on next day
          for (const vb of varsB) {
            const fromMidnight = timeToMinutes(vb.slot.startTime);
            const restHours = (toMidnight + fromMidnight) / 60;
            if (restHours < config.minRestHours) {
              constraints.push(`c${constraintIdx++}: ${va.varName} + ${vb.varName} <= 1`);
            }
          }
        }

        // Check backward: existing service on previous day → new slot on this day
        const prevDate = prevDateStr(dateA);
        const prevEnd = w.existingLastEnd.get(prevDate);
        if (prevEnd !== undefined) {
          const toMidnight = (24 * 60) - prevEnd;
          for (const va of varsA) {
            const fromMidnight = timeToMinutes(va.slot.startTime);
            const restHours = (toMidnight + fromMidnight) / 60;
            if (restHours < config.minRestHours) {
              constraints.push(`c${constraintIdx++}: ${va.varName} = 0`);
            }
          }
        }
      }
    }
  }

  // ── Date indicator variables: y_{w,d} ∈ {0,1} = 1 iff worker w works on date d ──
  // Used by C7 (max consecutive days) and C8 (rolling rest) for exact counting.
  // Linking: y >= x_{w,s} for each slot s on date d (any assignment activates the day)
  //          y <= Σ x_{w,s}  (day only counted if at least one slot assigned)
  type DateIndicator = { varName: string; workerId: string; date: string };
  const dateIndicatorVars: DateIndicator[] = [];
  // Map: workerId → date → indicator var name
  const dateIndicatorMap = new Map<string, Map<string, string>>();

  const needC7 = !config.disabledRules.has("HCR-L3132-1");
  const needC8 = !config.disabledRules.has("HCR-L3132-2");
  const needRedundancy = REDUNDANCY_WEIGHT > 0;
  if (needC7 || needC8 || needRedundancy) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars || wVars.length === 0) continue;

      // Group decision variables by date
      const varsByDate = new Map<string, VarInfo[]>();
      for (const v of wVars) {
        if (!varsByDate.has(v.slot.date)) varsByDate.set(v.slot.date, []);
        varsByDate.get(v.slot.date)!.push(v);
      }

      const workerIndicators = new Map<string, string>();
      for (const [date, dVars] of varsByDate) {
        // If worker already works this date (existing), no indicator needed — it's fixed
        if (w.existingWorkDates.has(date)) continue;

        const yName = `y_${auxIdx++}`;
        dateIndicatorVars.push({ varName: yName, workerId: w.id, date });
        workerIndicators.set(date, yName);

        // Linking: y >= x for each slot on this date
        for (const v of dVars) {
          constraints.push(`c${constraintIdx++}: ${yName} - ${v.varName} >= 0`);
        }
        // Linking: y <= sum(x) — day only active if at least one slot assigned
        const negTerms = dVars.map(v => `- ${v.varName}`).join(" ");
        constraints.push(`c${constraintIdx++}: ${yName} ${negTerms} <= 0`);

        // Redundancy (backup reservation): per-day penalty proportional to the
        // number of slots on this date the worker is eligible for. Versatile
        // workers (high N) are held in reserve so if someone calls out there
        // are replacement candidates still free.
        if (needRedundancy) {
          const N = dVars.length;
          const penalty = Math.round(REDUNDANCY_WEIGHT * N * 100) / 100;
          if (penalty > 0) objTerms.push(`- ${penalty} ${yName}`);
        }
      }
      dateIndicatorMap.set(w.id, workerIndicators);
    }
  }

  // C7: Max consecutive days (6) — exact formulation using date indicators
  if (needC7) {
    for (const w of workers) {
      const wVars = varsByWorker.get(w.id);
      if (!wVars) continue;
      const indicators = dateIndicatorMap.get(w.id) || new Map<string, string>();

      // Collect all dates with decision variables
      const datesWithVars = new Set<string>();
      for (const v of wVars) datesWithVars.add(v.slot.date);
      const sortedDates = [...datesWithVars].sort();
      if (sortedDates.length === 0) continue;

      // For each 7-day window containing at least one decision date:
      // existingCount + sum(y indicators in window) <= maxConsecutiveDays
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
          for (let i = 0; i < 7; i++) {
            windowDates.push(fmtDateUTC(d));
            d.setUTCDate(d.getUTCDate() + 1);
          }

          let existingCount = 0;
          const indicatorTerms: string[] = [];

          for (const wd of windowDates) {
            const yVar = indicators.get(wd);
            if (w.existingWorkDates.has(wd) && !yVar) {
              existingCount++;
            } else if (w.existingWorkDates.has(wd) && yVar) {
              // Already working + has decision vars — day is fixed as worked
              existingCount++;
            } else if (yVar) {
              indicatorTerms.push(yVar);
            }
          }

          if (indicatorTerms.length === 0) continue;
          const rhs = config.maxConsecutiveDays - existingCount;
          if (rhs <= 0) {
            // Already at limit — forbid all new dates in this window
            for (const term of indicatorTerms) {
              constraints.push(`c${constraintIdx++}: ${term} = 0`);
            }
          } else if (indicatorTerms.length > rhs) {
            constraints.push(`c${constraintIdx++}: ${indicatorTerms.join(" + ")} <= ${rhs}`);
          }
        }
      }
    }
  }

  // C8: Rolling rest — max 5 work days in any 7-day window — exact formulation
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
          for (let i = 0; i < 7; i++) {
            windowDates.push(fmtDateUTC(d));
            d.setUTCDate(d.getUTCDate() + 1);
          }

          let existingCount = 0;
          const indicatorTerms: string[] = [];

          for (const wd of windowDates) {
            const yVar = indicators.get(wd);
            if (w.existingWorkDates.has(wd) && !yVar) {
              existingCount++;
            } else if (w.existingWorkDates.has(wd) && yVar) {
              existingCount++;
            } else if (yVar) {
              indicatorTerms.push(yVar);
            }
          }

          if (indicatorTerms.length === 0) continue;
          const rhs = config.maxRollingWorkDays - existingCount;
          if (rhs <= 0) {
            for (const term of indicatorTerms) {
              constraints.push(`c${constraintIdx++}: ${term} = 0`);
            }
          } else if (indicatorTerms.length > rhs) {
            constraints.push(`c${constraintIdx++}: ${indicatorTerms.join(" + ")} <= ${rhs}`);
          }
        }
      }
    }
  }

  // C9: 12-week rolling average (46h) — per-week in multi-week mode with shifting window.
  //
  // Freshness gate (see c9-freshness.ts): for each worker, classify the 12-week
  // history by completeness. `high`/`medium` → apply C9 at the standard cap;
  // `low` → widen the cap by 10% to tolerate noise; `none` → skip C9 entirely
  // (weekly caps C4/C5 already bound hours — we just don't trust the rolling
  // average). Workers hired inside the 4-week bootstrap window always skip C9.
  //
  // The gate is the single source of truth — no secondary re-gating on raw
  // `historicalWeeks` thresholds (that would shadow the confidence bucket the
  // gate already chose, silently disabling C9 for low-confidence workers).
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

  if (!config.disabledRules.has("HCR-L3121-22")) {
    if (multiWeek) {
      for (const w of workers) {
        const decision = c9GateByWorker.get(w.id)!;
        if (!decision.apply) continue;
        const maxTotal = config.max12WeekAvgHours * 12 * decision.capMultiplier;
        for (let wk = 0; wk < multiWeek.numWeeks; wk++) {
          const baseHours = multiWeek.c9BaseHours.get(w.id)?.[wk] ?? 0;
          // Sum existing DB hours from planning weeks within the 12-week window
          let existingInWindow = 0;
          for (let j = Math.max(0, wk - 11); j <= wk; j++) {
            existingInWindow += multiWeek.existingHoursByWeek.get(w.id)?.[j] ?? 0;
          }
          const remaining = maxTotal - baseHours - existingInWindow;

          // Collect ILP vars from planning weeks within the 12-week window
          const windowVars: VarInfo[] = [];
          for (let j = Math.max(0, wk - 11); j <= wk; j++) {
            const jKey = `${w.id}_${j}`;
            const jVars = varsByWorkerWeek.get(jKey);
            if (jVars) windowVars.push(...jVars);
          }
          if (windowVars.length === 0) continue;

          if (remaining <= 0) {
            for (const v of windowVars) constraints.push(`c${constraintIdx++}: ${v.varName} = 0`);
          } else {
            const terms = windowVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
            constraints.push(`c${constraintIdx++}: ${terms} <= ${remaining}`);
          }
        }
      }
    } else {
      for (const w of workers) {
        const decision = c9GateByWorker.get(w.id)!;
        if (!decision.apply) continue;
        const wVars = varsByWorker.get(w.id);
        if (!wVars || wVars.length === 0) continue;
        const maxTotal = config.max12WeekAvgHours * 12 * decision.capMultiplier;
        const alreadyUsed = w.historicalHours + w.existingWeeklyHours;
        const remaining = maxTotal - alreadyUsed;
        if (remaining <= 0) {
          for (const v of wVars) constraints.push(`c${constraintIdx++}: ${v.varName} = 0`);
        } else {
          const terms = wVars.map(v => `${v.slot.hours} ${v.varName}`).join(" + ");
          constraints.push(`c${constraintIdx++}: ${terms} <= ${remaining}`);
        }
      }
    }
  }

  // C10: Role-based staffing — when a slot has roleBreakdown, prefer sub-role counts
  // These are SOFT constraints: we penalize shortfalls in the objective rather than
  // making them hard `>=` constraints, because hard requirements can conflict with
  // weekly hour caps (e.g. the only Chef de rang is already near their OT limit and
  // the compound slot exceeds their remaining hours — making the whole model infeasible).
  const ROLE_PENALTY = weights.rolePenalty;
  const softSlackVars: Array<{ varName: string; penalty: number; upperBound: number }> = [];
  const roleRequirementReductions: NonNullable<ILPResult["roleRequirementReductions"]> = [];

  {
    const breakdownSlots = new Map<string, ILPSlot[]>();
    for (const s of slots) {
      if (!s.roleBreakdown || Object.keys(s.roleBreakdown).length === 0) continue;
      if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) continue;
      const key = `${s.date}_${s.zone}_${s.role}`;
      if (!breakdownSlots.has(key)) breakdownSlots.set(key, []);
      breakdownSlots.get(key)!.push(s);
    }

    for (const [, groupSlots] of breakdownSlots) {
      for (const slot of groupSlots) {
        if (!slot.roleBreakdown) continue;

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
          // Per-assignment objective above prices the fit; here we just gate which
          // workers count toward the soft >= breakdown constraint.
          const allEligible = slotVars.filter(v => subRoleSubstitution(subRole, v.worker.subRoles).eligible);

          if (allEligible.length > 0 && needed > 0) {
            if (cappedNeeded > 0) {
              // Soft constraint: sum(eligible) + slack >= cappedNeeded
              const slackName = `sr_${softSlackVars.length}`;
              softSlackVars.push({ varName: slackName, penalty: ROLE_PENALTY, upperBound: cappedNeeded });
              constraints.push(
                `c${constraintIdx++}: ${allEligible.map(v => v.varName).join(" + ")} + ${slackName} >= ${cappedNeeded}`
              );
            }
          }
        }
      }
    }
  }

  // Step 3.5: Append soft constraint penalty terms to objective
  for (const sv of softSlackVars) {
    objTerms.push(`- ${sv.penalty} ${sv.varName}`);
  }
  for (const sv of softFloorSlacks) {
    objTerms.push(`- ${sv.penalty} ${sv.varName}`);
  }
  for (const sv of softC5Slacks) {
    objTerms.push(`- ${sv.penalty} ${sv.varName}`);
  }

  // ── Step 4: Assemble CPLEX LP format ──
  const lines: string[] = [];
  lines.push("\\Problem name: autostaffing");
  lines.push("Maximize");
  lines.push(` obj: ${objTerms.join(" ")}`);
  lines.push("Subject To");
  for (const c of constraints) {
    lines.push(` ${c}`);
  }
  lines.push("Bounds");
  for (const v of vars) {
    lines.push(` 0 <= ${v.varName} <= 1`);
  }
  // Bucket variable bounds (continuous, not integer)
  for (const [, buckets] of allBucketMap) {
    for (const b of buckets) {
      lines.push(` 0 <= ${b.varName} <= ${b.upperBound}`);
    }
  }
  // Soft constraint slack variable bounds (continuous)
  for (const sv of softSlackVars) {
    lines.push(` 0 <= ${sv.varName} <= ${sv.upperBound}`);
  }
  for (const sv of softFloorSlacks) {
    lines.push(` 0 <= ${sv.varName} <= ${sv.upperBound}`);
  }
  for (const sv of softC5Slacks) {
    lines.push(` 0 <= ${sv.varName} <= ${sv.upperBound}`);
  }
  // Date indicator variable bounds (binary)
  for (const di of dateIndicatorVars) {
    lines.push(` 0 <= ${di.varName} <= 1`);
  }
  lines.push("General");
  // Assignment variables + date indicators are integers (binary via bounds 0-1 + general)
  // Bucket variables remain continuous for the piecewise-linear approximation
  const integerVarNames = vars.map(v => v.varName);
  for (const di of dateIndicatorVars) integerVarNames.push(di.varName);
  lines.push(` ${integerVarNames.join(" ")}`);
  lines.push("End");

  const model = lines.join("\n");

  // ── Step 5: Solve with HiGHS (isolated in a worker thread) ──
  // Each solve runs in a fresh Worker — a WASM crash (Aborted) only kills the
  // worker, so the next call gets a pristine instance. The worker also handles
  // concurrency: the main-process singleton/mutex is no longer needed.
  let result: any;
  try {
    result = await solveInWorker(model);
  } catch (e: any) {
    console.error("HiGHS worker solve failed:", e?.message || e);
    return {
      status: "error",
      assignments: [],
      solveTimeMs: performance.now() - startTime,
      stats: { variables: vars.length, constraints: constraints.length, workers: workers.length, slots: slots.length },
    };
  }

  const solveTimeMs = performance.now() - startTime;

  // ── Step 6: Extract solution ──
  const status = result.Status === "Optimal" ? "optimal"
    : result.Status === "Feasible" ? "feasible"
    : result.Status === "Infeasible" ? "infeasible"
    : "error";

  const assignments: ILPResult["assignments"] = [];
  let perWeekWorkerHours: Map<string, number[]> | undefined;
  let perWeekWorkerServices: Map<string, number[]> | undefined;

  if (status === "optimal" || status === "feasible") {
    for (const v of vars) {
      const col = result.Columns[v.varName];
      if (col && Math.round(col.Primal) === 1) {
        const fit = pickBestSubRoleMatch(v.slot, v.worker);
        assignments.push({
          workerId: v.worker.id,
          workerName: v.worker.name,
          slotId: v.slot.id,
          filledAs: fit.filledAs,
          crossFilled: fit.crossFilled,
        });
      }
    }

    // Multi-week: extract per-week worker hours and service counts
    if (multiWeek) {
      perWeekWorkerHours = new Map();
      perWeekWorkerServices = new Map();
      for (const v of vars) {
        const col = result.Columns[v.varName];
        if (col && Math.round(col.Primal) === 1) {
          const wk = v.slot.week ?? 0;
          const wId = v.worker.id;
          if (!perWeekWorkerHours.has(wId)) {
            perWeekWorkerHours.set(wId, new Array(multiWeek.numWeeks).fill(0));
          }
          if (!perWeekWorkerServices.has(wId)) {
            perWeekWorkerServices.set(wId, new Array(multiWeek.numWeeks).fill(0));
          }
          perWeekWorkerHours.get(wId)![wk] += v.slot.hours;
          perWeekWorkerServices.get(wId)![wk] += 1;
        }
      }
    }
  }

  return {
    status,
    assignments,
    objectiveValue: result.ObjectiveValue,
    solveTimeMs,
    stats: {
      variables: vars.length + dateIndicatorVars.length,
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

// ── Utility helpers ──

function splitKey(key: string): [string, string] {
  const i = key.indexOf("_");
  return [key.substring(0, i), key.substring(i + 1)];
}

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
