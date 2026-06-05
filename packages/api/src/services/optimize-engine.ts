/**
 * Auto-optimization engine — multi-phase solver-driven staffing optimizer.
 *
 * Phase 1: Individual screening — test all workers × applicable strategies
 * Phase 2: Greedy compound plan building with perfection scoring
 * Phase 3: Hire estimation for remaining deficits
 * Phase 4: Reserved for policy recommendations that can be priced from labor data
 *
 * Extracted from settings.ts to keep routes thin and logic testable.
 */

import { db } from "../db/connection.js";
import { restaurants, workerRestrictions, staffingProfiles, users } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { analyzeStaffing, type StaffingAnalysis, type WorkerLoad } from "./staffing-analysis.js";
import { runMultiWeekSolve, extractMultiWeek, computeOtCapacity, otCapForMode, type MultiWeekExtract } from "./multi-week-solver.js";
import { fmtDate, getMonday } from "../utils/scheduling.js";
import {
  resolveWeights,
  parseCustomWeights,
  resolveHcrRate,
  type HcrLevel,
  type HcrGrid,
} from "@comptoir/shared";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";
import {
  KITCHEN_HIERARCHY,
  SALLE_HIERARCHY,
  getTrainingCost,
  crossTrainDefaultCost,
  intraTrainDefaultCost,
} from "./sub-role-training-cost.js";

// ── Types ──

export type OptimizationRecommendation = {
  id: string;
  type: "reduce_contract" | "remove_restrictions" | "reduce_to_planned" | "increase_hours" | "cross_train" | "intra_train" | "terminate";
  label: string;
  description: string;
  workerId: string;
  workerName: string;
  role: "kitchen" | "floor";
  contractType?: string | null;
  currentValue: number;
  proposedValue: number;
  impact: OptimizeImpact;
  score: number;
  /** Optional multi-worker contract overrides for practical combined moves,
   * e.g. non-renew one CDD while moving several 35h teammates to 39h. */
  contractOverrides?: Record<string, number>;
  /** Optional temporary weekly max/OT caps for practical overtime moves. */
  maxWeeklyOverrides?: Record<string, number>;
  /** For cross_train / intra_train: the resolved (fromRole, toRole) pair used for cost
   * lookup + outcome tracking. Populated only on training moves. */
  trainingFromRole?: string;
  trainingToRole?: string;
};

export type OptimizeImpact = {
  surplusHoursDelta: Record<string, number>;
  understaffedSlotsDelta: Record<string, number>;
  verdictChange?: { role: string; from: string; to: string };
  hoursRedistributed: number;
  affectedWorkers: Array<{ workerId: string; workerName: string; hoursDelta: number }>;
};

export type CompoundPlan = {
  id: string;
  label: string;
  description: string;
  moveIds: string[];
  /** Full action details for compound-only moves that are intentionally hidden
   * from standalone recommendations but must be understandable/applicable from
   * the recommended plan card. */
  actions?: OptimizationRecommendation[];
  totalImpact: OptimizeImpact;
  totalScore: number;
  finalState?: Record<string, { surplus: number; understaffed: number; verdict: string }>;
};

export type HireRecommendation = {
  id: string;
  type: "hire_cdi" | "hire_seasonal";
  label: string;
  description: string;
  role: "kitchen" | "floor";
  contractHours: number;
  neededSlots: Array<{ day: number; dayLabel: string; zone: string; startTime?: string; endTime?: string; subRoles?: string[]; currentFill?: number; target?: number }>;
  idealProfile?: {
    pattern: "midi" | "soir" | "coupure" | "mixte";
    days: string[];
    zones: string[];
    subRoles: string[];
  };
  analysisWeeks?: number;
  overtimeHoursReducedPerWeek?: number;
  overtimeCostReducedCents?: number;
  newHireCostCents?: number;
  netLaborSavingsCents?: number;
  score: number;
};

export type OtPolicyRecommendation = {
  id: string;
  type: "ot_policy_change";
  label: string;
  description: string;
  currentMode: string;
  proposedMode: string;
  proposedCap?: number;
  extraCapacityHours: Record<string, number>;
  score: number;
  /** "upgrade" = more OT headroom, "downgrade" = less. Absent = legacy path. */
  direction?: "upgrade" | "downgrade";
};

export type AutoOptimizeResult = {
  recommendations: OptimizationRecommendation[];
  compounds: CompoundPlan[];
  hireRecommendations: HireRecommendation[];
  otPolicyRecommendations: OtPolicyRecommendation[];
  baseline: {
    kitchen: RoleBaseline;
    floor: RoleBaseline;
    otMode: string;
    otWeeklyCap: number;
    scenariosRun: number;
  } | null;
  profiles: Array<{ id: string; name: string }>;
  activeProfileId: string | null;
  aborted?: boolean;
};

type RoleBaseline = {
  surplus: number;
  understaffed: number;
  verdict: string;
  totalContract: number;
  totalCapacity: number;
  totalDemand: number;
  otCapacity: number;
};

type Move = {
  rec: OptimizationRecommendation;
  contractOverride?: number;
  contractOverrides?: Record<string, number>;
  maxWeeklyOverrides?: Record<string, number>;
  restrictionOverride?: boolean;
  roleOverride?: string;
  subRoleOverride?: { workerId: string; addRoles: string[] };
  compoundEligible?: boolean;
  /** False for risky search-only moves (e.g. creates a sub-role gap alone)
   * that may become valid inside a compound with training/OT, but should not be
   * shown as standalone advice. */
  displayEligible?: boolean;
};

// ── Helpers (module-private) ──

function parsePartialHcrGrid(raw: string | null | undefined): Partial<HcrGrid> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Partial<HcrGrid> : {};
  } catch {
    return {};
  }
}

// ── Constants ──

const NUM_WEEKS = 12;
// Total solver-call budget across all phases. Single counter so the progress
// bar is monotonic; per-phase caps below stop earlier phases from starving
// later ones (Phase 1 fan-out used to consume the full budget, leaving Phase
// 2/3 silently empty). Caps preserve the original 80/110/120 proportions.
const DEFAULT_SOLVER_BUDGET = 160;
export function resolveSolverBudgetConfig(rawBudget = process.env.OPTIMIZE_SOLVER_BUDGET) {
  const parsed = rawBudget === undefined || rawBudget === "" ? NaN : Number(rawBudget);
  const solverBudget = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SOLVER_BUDGET;
  const phase1BudgetCap = Math.max(1, Math.min(solverBudget, Math.round(solverBudget * (80 / 120))));
  const phase2BudgetCap = Math.max(phase1BudgetCap, Math.min(solverBudget, Math.round(solverBudget * (110 / 120))));
  return {
    solverBudget,
    phase1BudgetCap,
    phase2BudgetCap,
    phase3BudgetCap: solverBudget,
  } as const;
}
const {
  solverBudget: SOLVER_BUDGET,
  phase1BudgetCap: PHASE1_BUDGET_CAP,
  phase2BudgetCap: PHASE2_BUDGET_CAP,
  phase3BudgetCap: PHASE3_BUDGET_CAP,
} = resolveSolverBudgetConfig();
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_COMPOUND_NO_IMPROVEMENT_STREAK = Math.max(8, Math.round(SOLVER_BUDGET * 0.075));
// Phase 1 screening fans out independent what-if scenarios. They share no
// state, so we dispatch them in parallel chunks. Real wall-time speedup
// requires solver-side capacity (gunicorn -w N or multi-URL CPSAT_SOLVER_URLS);
// with a single solver worker the requests serialize at the HTTP layer.
const SCREENING_CONCURRENCY = Math.max(1, Number(process.env.OPTIMIZE_SCENARIO_CONCURRENCY) || 4);

// Scoring weights. `understaffedPerSlot` keeps coverage/sub-role fill primary;
// `SURPLUS_OBJECTIVE` below handles final structural surplus with stricter
// waste tiers so +8h/+15h persistent surplus does not look "optimized".
// `surplusPerHour` remains used by Phase-1 raw impact screening.
export const PERFECTION_WEIGHTS = {
  baseline: 1000,
  surplusPerHour: 3,
  deficitCoveredByOtPerHour: 1.5,
  deficitBeyondOtPerHour: 25,
  understaffedPerSlot: 60,
} as const;

// Surplus is bad even in tiny amounts: any positive hours are at least as costly
// per hour as the OT-covered deficit penalty, so the gradient points toward a
// small negative landing. `sweetSpot*` reward up to N hours of OT-coverable
// deficit — the operator's preferred final state per business spec.
export const SURPLUS_OBJECTIVE = {
  positiveWarningHours: 4,
  positiveBadHours: 8,
  positiveWarningPenaltyPerHour: 2,
  positiveBadPenaltyPerHour: 7,
  positiveWastePenaltyPerHour: 12,
  willingOtPenaltyPerHour: 1.25,
  deficitBeyondWillingOtPenaltyPerHour: 25,
  sweetSpotMaxHours: 4,
  sweetSpotBonusPerHour: 2,
} as const;

export function computeFinalSurplusPenalty(finalSurplus: number, willingOtCapacity: number): number {
  const w = SURPLUS_OBJECTIVE;
  if (finalSurplus >= 0) {
    let remaining = finalSurplus;
    let penalty = 0;
    const warning = Math.min(remaining, w.positiveWarningHours);
    penalty += warning * w.positiveWarningPenaltyPerHour;
    remaining -= warning;
    const bad = Math.min(Math.max(0, remaining), w.positiveBadHours - w.positiveWarningHours);
    penalty += bad * w.positiveBadPenaltyPerHour;
    remaining -= bad;
    penalty += Math.max(0, remaining) * w.positiveWastePenaltyPerHour;
    return penalty;
  }

  const deficit = Math.abs(finalSurplus);
  const covered = Math.min(deficit, Math.max(0, willingOtCapacity));
  const uncovered = Math.max(0, deficit - covered);
  const sweet = Math.min(covered, w.sweetSpotMaxHours);
  const beyondSweet = covered - sweet;
  return -sweet * w.sweetSpotBonusPerHour
    + beyondSweet * w.willingOtPenaltyPerHour
    + uncovered * w.deficitBeyondWillingOtPenaltyPerHour;
}

/**
 * Pure scoring helper for compound plan acceptance in Phase 2.
 *
 * Returns a scalar where higher = better. The baseline (no moves, no impact)
 * scores 1000 minus per-role final surplus/understaffed penalties from current
 * state. Positive structural surplus is treated as persistent waste; slight
 * negative surplus is acceptable only when covered by willing/explicit OT cap.
 * Creating new unfilled slots remains heavily penalized.
 */
export function computePerfectionScore(args: {
  baseSurplusByRole: Record<string, number>;
  baseUnderstaffedByRole: Record<string, number>;
  otCapacityByRole: Record<string, number>;
  impact: Pick<OptimizeImpact, "surplusHoursDelta" | "understaffedSlotsDelta">;
  moveCostTotal: number;
  roles?: readonly string[];
}): number {
  const roles = args.roles ?? ["kitchen", "floor"];
  let score = PERFECTION_WEIGHTS.baseline;
  for (const role of roles) {
    const roleOtCap = args.otCapacityByRole[role] ?? 0;
    const baseSurplus = args.baseSurplusByRole[role] ?? 0;
    const finalSurplus = baseSurplus + (args.impact.surplusHoursDelta[role] ?? 0);
    score -= computeFinalSurplusPenalty(finalSurplus, roleOtCap);
    const baseUnder = args.baseUnderstaffedByRole[role] ?? 0;
    const finalUnderstaffed = baseUnder + (args.impact.understaffedSlotsDelta[role] ?? 0);
    score -= Math.max(0, finalUnderstaffed) * PERFECTION_WEIGHTS.understaffedPerSlot;
  }
  score -= args.moveCostTotal;
  return Math.round(score);
}

function computeHighUnderstaffingRiskPenalty(slots: number): number {
  if (slots <= 2) return 0;
  if (slots <= 4) return (slots - 2) * 120;
  return 240 + ((slots - 4) * 180);
}

export function computePlanRankScore(args: {
  plan: Pick<CompoundPlan, "totalScore" | "finalState">;
  otCapacityByRole?: Record<string, number>;
  roles?: readonly string[];
}): number {
  const roles = args.roles ?? ["kitchen", "floor"];
  const surplusTieBreaker = roles.reduce((sum, role) => {
    const fs = args.plan.finalState?.[role];
    return sum + (fs ? computeFinalSurplusPenalty(fs.surplus, args.otCapacityByRole?.[role] ?? 0) : 0);
  }, 0) * 0.25;
  const highUnderstaffingRisk = roles.reduce((sum, role) => sum + computeHighUnderstaffingRiskPenalty(args.plan.finalState?.[role]?.understaffed ?? 0), 0);
  return Math.round(args.plan.totalScore - surplusTieBreaker - highUnderstaffingRisk);
}

// Reject a plan only when its coverage damage is unrecoverable: too many new
// unfilled slots to absorb structurally, or a deficit larger than willing OT
// capacity. A handful of new structural shortfalls is left to the score
// function to weigh against surplus reduction (each slot already costs 60
// perfection points) — that's the right place to make the tradeoff so the
// optimizer can pick a plan that trades one unfilled slot for −20h surplus.
const MAX_NEW_STRUCTURAL_SHORTFALLS = 3;
export function planWorsensUnderstaffing(args: {
  plan: Pick<CompoundPlan, "finalState">;
  baseUnderstaffedByRole: Record<string, number>;
  otCapacityByRole?: Record<string, number>;
  roles?: readonly string[];
}): boolean {
  const roles = args.roles ?? ["kitchen", "floor"];
  return roles.some(role => {
    const state = args.plan.finalState?.[role];
    const finalUnder = state?.understaffed ?? 0;
    const baseUnder = args.baseUnderstaffedByRole[role] ?? 0;
    const newUnder = finalUnder - baseUnder;
    if (newUnder <= 0) return false;
    const finalSurplus = state?.surplus ?? 0;
    const otCap = Math.max(0, args.otCapacityByRole?.[role] ?? 0);
    const deficit = finalSurplus < 0 ? Math.abs(finalSurplus) : 0;
    // Deficit overflowing OT cap is always rejected — by then neither surplus
    // reduction nor OT can recover the gap.
    if (deficit > otCap) return true;
    // Otherwise tolerate a small structural shortfall; the score function
    // already penalises each new slot at 60 pt and will only pick this plan
    // when the surplus cut clearly outweighs.
    return newUnder > MAX_NEW_STRUCTURAL_SHORTFALLS;
  });
}

/**
 * User-facing recommendation score. Phase-1 raw score remains pure staffing
 * impact for solver pruning/compound construction; this display score applies
 * HR feasibility so the top list matches what an owner can realistically do.
 */
function isSeasonalContract(contractType: string | null | undefined): boolean {
  return contractType === "saisonnier";
}

function isSimpleHcrReduction(currentValue: number, proposedValue: number): boolean {
  return currentValue === 39 && proposedValue >= 35 && proposedValue < currentValue;
}

function deepContractReductionCost(contractType: string | null | undefined, currentValue: number, proposedValue: number): number {
  const reductionPct = 1 - (proposedValue / Math.max(1, currentValue));
  const below35 = proposedValue > 0 && proposedValue < 35;
  const below30 = proposedValue > 0 && proposedValue < 30;
  const below24 = proposedValue > 0 && proposedValue < 24;
  const base = contractType === "CDD" ? 35 : 45;
  return base
    + Math.round(reductionPct * 70)
    + (below35 ? 20 : 0)
    + (below30 ? 20 : 0)
    + (below24 ? 25 : 0);
}

export function scoreRecommendationForDisplay(rec: Pick<OptimizationRecommendation, "type" | "contractType" | "currentValue" | "proposedValue" | "score" | "contractOverrides" | "maxWeeklyOverrides">): number {
  const contractType = rec.contractType ?? "CDI";
  let adjustment = 0;

  if (rec.type === "terminate") {
    if (contractType === "CDD") adjustment += 12;
    else if (isSeasonalContract(contractType)) adjustment += 15;
    else adjustment -= 55;
    if (rec.contractOverrides && Object.keys(rec.contractOverrides).length > 1) adjustment += 8;
    if (rec.maxWeeklyOverrides && Object.keys(rec.maxWeeklyOverrides).length > 0) adjustment += 6;
  } else if (rec.type === "reduce_to_planned" || rec.type === "reduce_contract") {
    if (isSeasonalContract(contractType)) {
      adjustment += 8;
    } else if (isSimpleHcrReduction(rec.currentValue, rec.proposedValue)) {
      adjustment += contractType === "CDD" ? 8 : 4;
    } else {
      adjustment -= deepContractReductionCost(contractType, rec.currentValue, rec.proposedValue);
    }
  } else if (rec.type === "increase_hours" && rec.proposedValue <= 39) {
    adjustment += 8;
  }

  return Math.round(rec.score + adjustment);
}

export function isPracticalContractReductionForCompound(args: { contractType?: string | null; currentValue: number; proposedValue: number }): boolean {
  if (args.proposedValue <= 0 || args.proposedValue >= args.currentValue) return true;
  if (isSeasonalContract(args.contractType)) return true;
  // CDI/CDD deep cuts (39→27, 35→17) need an avenant + worker signature, but
  // their move cost via deepContractReductionCost already encodes that
  // difficulty (45–170 pts depending on depth). Allowing them in compound
  // plans lets the optimizer cut massively over-staffed roles; the user can
  // always deselect individual moves. Block only near-termination cuts
  // (proposed ≤ 20% of original) — those should be explicit terminate moves.
  return args.proposedValue / Math.max(1, args.currentValue) >= 0.2;
}

export function formatContractBumpSummary(
  contractOverrides: Record<string, number> | undefined,
  workers: Array<{ workerId: string; workerName: string; contractHours?: number | null }>,
  removedWorkerId: string,
): string | null {
  if (!contractOverrides) return null;
  const bumped = workers
    .filter(w => w.workerId !== removedWorkerId)
    .map(w => {
      const proposed = contractOverrides[w.workerId];
      const current = w.contractHours ?? 35;
      return proposed !== undefined && proposed > current ? `${w.workerName} ${current}h→${proposed}h` : null;
    })
    .filter((v): v is string => Boolean(v));
  return bumped.length > 0 ? bumped.join(", ") : null;
}

export function formatMaxWeeklySummary(
  maxWeeklyOverrides: Record<string, number> | undefined,
  workers: Array<{ workerId: string; workerName: string }>,
): string | null {
  if (!maxWeeklyOverrides) return null;
  const bumped = workers
    .filter(w => maxWeeklyOverrides[w.workerId] !== undefined)
    .map(w => `${w.workerName} jusqu'à ${maxWeeklyOverrides[w.workerId]}h`);
  return bumped.length > 0 ? bumped.join(", ") : null;
}

function describeHrFeasibility(rec: OptimizationRecommendation): OptimizationRecommendation {
  if (rec.type !== "reduce_to_planned" && rec.type !== "reduce_contract") return rec;
  if (isSeasonalContract(rec.contractType)) return rec;
  if (isSimpleHcrReduction(rec.currentValue, rec.proposedValue)) return rec;
  if (rec.contractType === "CDI") {
    return {
      ...rec,
      label: "Surplus CDI à traiter",
      description: `${rec.description} Accord salarié requis — à traiter comme sujet RH, pas comme ajustement automatique.`,
    };
  }
  if (rec.contractType === "CDD") {
    return {
      ...rec,
      description: `${rec.description} Avenant/accord nécessaire si le contrat est déjà signé.`,
    };
  }
  return rec;
}

// ── Main entry point ──

export type ProgressEvent = {
  phase: string;
  current: number;
  total: number;
  label: string;
};

export async function runAutoOptimize(
  restaurantId: string,
  profileId?: string,
  allowedLevers?: Set<string>,
  onProgress?: (evt: ProgressEvent) => void,
  signal?: AbortSignal,
  roleFilter?: "kitchen" | "floor",
): Promise<AutoOptimizeResult> {
  const levers = allowedLevers ?? new Set(["reduce", "increase", "terminate", "cross_train", "intra_train", "remove_restrictions"]);

  // 1. Baseline analysis
  const baseResult = analyzeStaffing(restaurantId, profileId);

  // Load OT + sub-role settings
  const restRow = db.select({
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
    hcrGrid: restaurants.hcrGrid,
    subroleHcrMap: restaurants.subroleHcrMap,
    kitchenSubRoles: restaurants.kitchenSubRoles,
    floorSubRoles: restaurants.floorSubRoles,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  const otMode = restRow[0]?.overtimeMode ?? "flexible";
  const otWeeklyCap = restRow[0]?.overtimeWeeklyCap ?? 48;
  const hcrGrid = parsePartialHcrGrid(restRow[0]?.hcrGrid);

  // Sub-roles are configured per restaurant. The optimizer must not propose
  // training someone into a sub-role that doesn't exist for this restaurant
  // (e.g. "Sous-chef" on a restaurant whose kitchen only has "Chef"/"Cuisinier").
  const parseConfiguredSubRoles = (raw: string | null | undefined): Set<string> => {
    if (!raw) return new Set();
    try { return new Set(JSON.parse(raw) as string[]); } catch { return new Set(); }
  };
  const configuredKitchenSubRoles = parseConfiguredSubRoles(restRow[0]?.kitchenSubRoles);
  const configuredFloorSubRoles = parseConfiguredSubRoles(restRow[0]?.floorSubRoles);
  const configuredSubRolesFor = (role: "kitchen" | "floor") =>
    role === "kitchen" ? configuredKitchenSubRoles : configuredFloorSubRoles;

  // Per-worker hourly rate resolution (HCR grid + admin override). Used only by
  // Phase 4 OT cost-delta evaluation; extracted here so the rates are frozen
  // against the HCR grid state at the start of the optimize run.
  const memberWorkerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["kitchen", "floor"] });
  const workerRateRows = memberWorkerIds.length > 0 ? db.select({
    id: users.id,
    hcrLevel: users.hcrLevel,
    hourlyRate: users.hourlyRate,
  }).from(users).where(inArray(users.id, memberWorkerIds)).all() : [];
  const workerRateByIdCents = new Map<string, number>();
  for (const w of workerRateRows) {
    const rate = resolveHcrRate(w.hcrLevel as HcrLevel | null, w.hourlyRate, hcrGrid);
    if (rate && rate > 0) workerRateByIdCents.set(w.id, rate);
  }
  const avgRateForRole = (role: "kitchen" | "floor") => {
    const rates = baseResult.workerLoads
      .filter(w => w.role === role)
      .map(w => workerRateByIdCents.get(w.workerId))
      .filter((rate): rate is number => typeof rate === "number" && rate > 0);
    if (rates.length === 0) return 1300;
    return Math.round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length);
  };
  const styleWeights = resolveWeights(restRow[0]?.preferredStyle, parseCustomWeights(restRow[0]?.customWeights));

  // Enrich capacity with OT
  for (const cap of baseResult.capacity) {
    const roleWorkers = baseResult.workerLoads.filter(w => w.role === cap.role);
    cap.otCapacityHours = Math.round(computeOtCapacity(roleWorkers, otMode, otWeeklyCap));
    cap.effectiveCapacityHours = cap.totalContractHours + cap.otCapacityHours;
  }

  const baseMonday = getMonday(fmtDate((() => {
    const d = new Date(); d.setDate(d.getDate() + 28 - d.getDay() + 1); return d;
  })()));

  // Baseline multi-week solve
  onProgress?.({ phase: "baseline", current: 0, total: SOLVER_BUDGET, label: "Résolution du scénario de référence…" });
  let baseWorkerHours = new Map<string, number>();
  let baseMinFills = new Map<string, number>();
  // Per-week slot-group fills for baseline floor constraints (prevents training scenarios from degrading coverage)
  let baselineSlotFillFloors = new Map<string, number>();
  const baselinePlanOpts = profileId ? { profileIdOverride: profileId } : undefined;
  try {
    const { ilpResult, mergedSlots, existingHoursByWeek } = await runMultiWeekSolve(
      restaurantId, baseMonday, NUM_WEEKS, baselinePlanOpts, undefined, styleWeights, 1, restRow[0]?.preferredStyle,
    );
    const extracted = extractMultiWeek(ilpResult, mergedSlots, existingHoursByWeek, NUM_WEEKS);
    baseWorkerHours = extracted.avgWorkerHours;
    baseMinFills = extracted.minFills;

    // Build per-(week, dow, role, zone) fill counts from baseline assignments
    // Use representative slot (skip compound pair's second slot) for consistency with the solver's C1b grouping
    const slotMap = new Map(mergedSlots.map(s => [s.id, s]));
    const slotNewFills = new Map<number, number>();
    for (const a of ilpResult.assignments) {
      slotNewFills.set(a.slotId, (slotNewFills.get(a.slotId) ?? 0) + 1);
    }
    const groupFills = new Map<string, number>();
    for (const s of mergedSlots) {
      // Skip compound pair's second slot (same dedup as the solver's C1b)
      if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) continue;
      const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
      const totalFill = s.existingFill + (slotNewFills.get(s.id) ?? 0);
      const prev = groupFills.get(key);
      groupFills.set(key, prev === undefined ? totalFill : Math.max(prev, totalFill));
    }
    baselineSlotFillFloors = groupFills;
  } catch (e) {
    console.error("Auto-optimize multi-week solve failed:", e);
    return { recommendations: [], compounds: [], hireRecommendations: [], otPolicyRecommendations: [], baseline: null, profiles: baseResult.profiles, activeProfileId: baseResult.activeProfileId };
  }

  if (baseWorkerHours.size === 0) {
    return { recommendations: [], compounds: [], hireRecommendations: [], otPolicyRecommendations: [], baseline: null, profiles: baseResult.profiles, activeProfileId: baseResult.activeProfileId };
  }

  // ── Helper closures ──

  const workerLoads = roleFilter
    ? baseResult.workerLoads.filter(w => w.role === roleFilter)
    : baseResult.workerLoads;
  const employmentActionWorkerLoads = workerLoads.filter((worker) => !worker.sharedFromRestaurantId);

  const workerOtPrefs = new Map((memberWorkerIds.length > 0 ? db.select({
    id: users.id,
    overtimeWilling: users.overtimeWilling,
    maxWeeklyHours: users.maxWeeklyHours,
    adminOtOverride: users.adminOtOverride,
  }).from(users).where(inArray(users.id, memberWorkerIds)).all() : [])
    .map(w => [w.id, w]));

  const baseUnderstaffed = (role: string) =>
    baseResult.slots.filter(s => s.role === role && s.status !== "closed" && s.target > 0).filter(s => {
      const key = `${s.dayOfWeek}_${s.role}_${s.zone}`;
      return (baseMinFills.get(key) || 0) < s.target;
    }).length;

  const baseSurplus = (role: string) => {
    const cap = baseResult.capacity.find(c => c.role === role);
    return cap?.surplusHours ?? 0;
  };

  const overtimeHours = (hours: number) => Math.max(0, hours - 39);

  function weeklyLaborCostCents(hours: number, rateCents: number) {
    let remaining = Math.max(0, hours);
    let cursor = 0;
    let cost = 0;
    const addBand = (bandEnd: number, multiplier: number) => {
      if (remaining <= 0 || cursor >= bandEnd) return;
      const bandHours = Math.min(remaining, bandEnd - cursor);
      cost += bandHours * rateCents * multiplier;
      cursor += bandHours;
      remaining -= bandHours;
    };
    addBand(39, 1);
    addBand(43, 1.10);
    addBand(47, 1.20);
    if (remaining > 0) cost += remaining * rateCents * 1.50;
    return cost;
  }

  function weeklyOvertimeCostCents(hours: number, rateCents: number) {
    return weeklyLaborCostCents(hours, rateCents) - weeklyLaborCostCents(Math.min(hours, 39), rateCents);
  }

  function contractVerdict(role: string) {
    const cap = baseResult.capacity.find(c => c.role === role);
    if (!cap) return "balanced";
    const understaffed = baseUnderstaffed(role);
    const otBuffer = cap.otCapacityHours;
    if (cap.surplusHours < 0 && Math.abs(cap.surplusHours) > otBuffer) return "undersized";
    if (understaffed > 0) return "tight";
    if (cap.surplusHours > 0 && cap.hoursRatio > 1.2) return "oversized";
    return "balanced";
  }

  // Fetch restriction data
  const restrictionRows = db.select({
    workerId: workerRestrictions.workerId,
    dayOfWeek: workerRestrictions.dayOfWeek,
  }).from(workerRestrictions)
    .where(eq(workerRestrictions.restaurantId, restaurantId)).all();
  const workersWithRestrictions = new Set(restrictionRows.map(r => r.workerId));

  // Sub-role protection
  const hasSubRoles = workerLoads.some(w => w.subRoles && w.subRoles.length > 0);
  function hasUniqueSubRole(w: WorkerLoad): string | null {
    if (!hasSubRoles) return null;
    const rolemates = workerLoads.filter(wl => wl.role === w.role && wl.workerId !== w.workerId);
    for (const sr of w.subRoles) {
      const othersWithRole = rolemates.filter(wl => wl.subRoles.includes(sr));
      if (othersWithRole.length === 0) return sr;
    }
    return null;
  }

  async function runScenario(
    contractOverrides?: Record<string, number>,
    restrictionOverrides?: string[],
    roleOverrides?: Record<string, string>,
    subRoleOverrides?: Record<string, string[]>,
    virtualWorkers?: Array<{ id: string; name: string; role: string; contractHours: number }>,
    slotFillFloors?: Map<string, number>,
    maxWeeklyOverrides?: Record<string, number>,
  ): Promise<MultiWeekExtract> {
    const planOpts = (contractOverrides || maxWeeklyOverrides || restrictionOverrides || roleOverrides || subRoleOverrides || virtualWorkers || profileId)
      ? { contractOverrides, maxWeeklyOverrides, restrictionOverrides, roleOverrides, subRoleOverrides, virtualWorkers, profileIdOverride: profileId } : undefined;
    const { ilpResult, mergedSlots, existingHoursByWeek } = await runMultiWeekSolve(
      restaurantId, baseMonday, NUM_WEEKS, planOpts, slotFillFloors, styleWeights, 1, restRow[0]?.preferredStyle,
    );
    return extractMultiWeek(ilpResult, mergedSlots, existingHoursByWeek, NUM_WEEKS);
  }

  // Like runScenario but also returns raw assignments + slots for hire analysis
  async function runHireScenario(
    virtualWorkers: Array<{ id: string; name: string; role: string; contractHours: number }>,
  ) {
    const planOpts = { virtualWorkers, profileIdOverride: profileId };
    const { ilpResult, mergedSlots, existingHoursByWeek } = await runMultiWeekSolve(
      restaurantId, baseMonday, NUM_WEEKS, planOpts, undefined, styleWeights, 1, restRow[0]?.preferredStyle,
    );
    const extract = extractMultiWeek(ilpResult, mergedSlots, existingHoursByWeek, NUM_WEEKS);
    return { ...extract, assignments: ilpResult.assignments, slots: mergedSlots, numWeeks: NUM_WEEKS };
  }

  function computeImpact(
    scenarioWorkerHours: Map<string, number>,
    scenarioMinFills: Map<string, number>,
    contractOverrides?: Record<string, number>,
    roleOverrides?: Record<string, string>,
  ): OptimizeImpact {
    const surplusHoursDelta: Record<string, number> = {};
    const understaffedSlotsDelta: Record<string, number> = {};
    for (const role of ["kitchen", "floor"]) {
      const roleLoads = workerLoads.filter(w => w.role === role);
      const baseTotalContract = roleLoads.reduce((s, w) => s + (w.contractHours ?? 35), 0);
      const newTotalContract = workerLoads
        .filter(w => (roleOverrides?.[w.workerId] ?? w.role) === role)
        .reduce((s, w) => {
          const ovr = contractOverrides?.[w.workerId];
          return s + (ovr !== undefined ? ovr : (w.contractHours ?? 35));
        }, 0);
      const demandH = baseResult.capacity.find(c => c.role === role)?.totalDemandHours ?? 0;
      surplusHoursDelta[role] = Math.round((newTotalContract - demandH) - (baseTotalContract - demandH));
      const roleSlots = baseResult.slots.filter(s => s.role === role && s.status !== "closed" && s.target > 0);
      const newUnder = roleSlots.filter(s => {
        const key = `${s.dayOfWeek}_${s.role}_${s.zone}`;
        return (scenarioMinFills.get(key) || 0) < s.target;
      }).length;
      understaffedSlotsDelta[role] = newUnder - baseUnderstaffed(role);
    }
    const affectedWorkers: Array<{ workerId: string; workerName: string; hoursDelta: number }> = [];
    let totalRedistributed = 0;
    for (const wl of workerLoads) {
      const baseH = baseWorkerHours.get(wl.workerId) ?? 0;
      const newH = scenarioWorkerHours.get(wl.workerId) ?? 0;
      if (baseH !== newH) {
        affectedWorkers.push({ workerId: wl.workerId, workerName: wl.workerName, hoursDelta: Math.round((newH - baseH) * 10) / 10 });
        totalRedistributed += Math.abs(newH - baseH);
      }
    }
    affectedWorkers.sort((a, b) => b.hoursDelta - a.hoursDelta);
    return { surplusHoursDelta, understaffedSlotsDelta, hoursRedistributed: Math.round(totalRedistributed * 10) / 10, affectedWorkers };
  }

  // Phase-1 ranker. Uses the same tiered SURPLUS_OBJECTIVE penalty as Phase-2's
  // compound scoring so the "good move" notion matches across phases. A flat
  // pt/h here would mis-rank moves: above the 8h waste tier each saved hour is
  // worth 12 pts, not 3, so contract reductions on a heavily-overstaffed role
  // were buried by training moves with much smaller real impact.
  function scoreImpact(impact: OptimizeImpact) {
    let score = 0;
    for (const role of ["kitchen", "floor"]) {
      const baseS = baseSurplus(role);
      const otCap = baseResult.capacity.find(c => c.role === role)?.otCapacityHours ?? 0;
      const delta = impact.surplusHoursDelta[role] ?? 0;
      const before = computeFinalSurplusPenalty(baseS, otCap);
      const after = computeFinalSurplusPenalty(baseS + delta, otCap);
      score += before - after;
      score -= (impact.understaffedSlotsDelta[role] ?? 0) * PERFECTION_WEIGHTS.understaffedPerSlot;
    }
    return Math.round(score);
  }

  function moveCost(m: Move): number {
    const extraContractBumpCost = Object.entries(moveContractOverrides(m)).reduce((sum, [workerId, proposed]) => {
      if (workerId === m.rec.workerId) return sum;
      const worker = workerLoads.find(w => w.workerId === workerId);
      const current = worker?.contractHours ?? 35;
      if (proposed <= current) return sum;
      if (proposed <= 39) return sum + 2;
      return sum + 4 + Math.round((proposed - current) / 2);
    }, 0);
    const extraOtCost = Object.keys(moveMaxWeeklyOverrides(m)).length * 4;
    if (m.rec.type === "terminate") {
      const base = m.rec.contractType === "saisonnier" ? 1 : m.rec.contractType === "CDD" ? 8 : 40;
      return base + extraContractBumpCost + extraOtCost; // CDI: licenciement/rupture conv. = expensive
    }
    if (m.rec.type === "reduce_to_planned") {
      if (isSeasonalContract(m.rec.contractType)) return 2;
      if (isSimpleHcrReduction(m.rec.currentValue, m.rec.proposedValue)) return 3;
      return deepContractReductionCost(m.rec.contractType, m.rec.currentValue, m.rec.proposedValue);
    }
    if (m.rec.type === "increase_hours") {
      // Adding hours up to the HCR 39h reference is usually easy; above that,
      // keep a small cost because it starts leaning on overtime policy.
      if (m.rec.proposedValue <= 39) return 2;
      const increasePct = (m.rec.proposedValue - m.rec.currentValue) / Math.max(1, m.rec.currentValue);
      return 5 + Math.round(increasePct * 10);
    }
    if (m.rec.type === "cross_train") {
      // Sub-role distance: same family = cheaper, cross-family = very expensive
      return crossTrainCost(m.rec);
    }
    if (m.rec.type === "intra_train") {
      // Intra-role training: easier than cross-department, depends on sub-role distance
      return intraTrainCost(m.rec);
    }
    // remove_restrictions: real negotiation, restrictions exist for a reason
    return 8;
  }

  // Resolve the worker's best-ranked sub-role within a hierarchy. Returns the
  // literal sub-role string (stable key for cost storage) or the role name
  // itself when the worker has no recognised sub-role — workers without a
  // trained skill are treated as entry-level for the pair key.
  function bestSubRole(workerId: string, hierarchy: readonly string[]): string {
    const w = workerLoads.find(wl => wl.workerId === workerId);
    const subRoles = w?.subRoles ?? [];
    let bestIdx = hierarchy.length;
    let bestName: string | null = null;
    for (const sr of subRoles) {
      const idx = hierarchy.indexOf(sr);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        bestName = sr;
      }
    }
    return bestName ?? hierarchy[hierarchy.length - 1] ?? "";
  }

  function moveContractOverrides(m: Move): Record<string, number> {
    if (m.contractOverrides) return m.contractOverrides;
    if (m.contractOverride !== undefined) return { [m.rec.workerId]: m.contractOverride };
    return {};
  }

  function moveMaxWeeklyOverrides(m: Move): Record<string, number> {
    return m.maxWeeklyOverrides ?? m.rec.maxWeeklyOverrides ?? {};
  }

  function crossTrainCost(rec: OptimizationRecommendation): number {
    const fromHierarchy = rec.role === "kitchen" ? KITCHEN_HIERARCHY : SALLE_HIERARCHY;
    const fromSubRole = rec.trainingFromRole ?? bestSubRole(rec.workerId, fromHierarchy);
    const toRole = rec.trainingToRole ?? (rec.role === "kitchen" ? "floor" : "kitchen");
    const def = crossTrainDefaultCost(fromSubRole, rec.role);
    return getTrainingCost(restaurantId, fromSubRole, toRole, def);
  }

  function intraTrainCost(rec: OptimizationRecommendation): number {
    const hierarchy = rec.role === "kitchen" ? KITCHEN_HIERARCHY : SALLE_HIERARCHY;
    const fromSubRole = rec.trainingFromRole ?? bestSubRole(rec.workerId, hierarchy);
    // Target sub-role stored by name (preferred) or derived from proposedValue
    // index into the hierarchy (legacy: index-only recs).
    const toSubRole = rec.trainingToRole ?? hierarchy[rec.proposedValue] ?? "";
    const def = intraTrainDefaultCost(fromSubRole, toSubRole, rec.role);
    return getTrainingCost(restaurantId, fromSubRole, toSubRole, def);
  }

  function scorePerfection(impact: OptimizeImpact, moves: Move[]) {
    const roles = ["kitchen", "floor"];
    const baseSurplusByRole: Record<string, number> = {};
    const baseUnderstaffedByRole: Record<string, number> = {};
    const otCapacityByRole: Record<string, number> = {};
    const maxOverrides = moves.reduce<Record<string, number>>((acc, m) => ({ ...acc, ...moveMaxWeeklyOverrides(m) }), {});
    const contractOverrides = moves.reduce<Record<string, number>>((acc, m) => ({ ...acc, ...moveContractOverrides(m) }), {});
    for (const role of roles) {
      baseSurplusByRole[role] = baseSurplus(role);
      baseUnderstaffedByRole[role] = baseUnderstaffed(role);
      otCapacityByRole[role] = workerLoads
        .filter(w => w.role === role)
        .reduce((sum, w) => {
          const prefs = workerOtPrefs.get(w.workerId);
          const contract = contractOverrides[w.workerId] ?? (w.contractHours ?? 35);
          if (contract <= 0) return sum;
          const cap = maxOverrides[w.workerId] ?? (prefs?.overtimeWilling ? (prefs.maxWeeklyHours ?? prefs.adminOtOverride ?? otCapForMode(otMode, otWeeklyCap)) : contract);
          return sum + Math.max(0, cap - contract);
        }, 0);
    }
    return computePerfectionScore({
      baseSurplusByRole,
      baseUnderstaffedByRole,
      otCapacityByRole,
      impact,
      moveCostTotal: moves.reduce((s, m) => s + moveCost(m), 0),
      roles,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Individual screening
  // ═══════════════════════════════════════════════════════════════
  let aborted = false;
  const allMoves: Move[] = [];
  // Termination absorption variants (39h bumps / temporary 46h OT caps) can be
  // useless as standalone recommendations while still being the decisive third
  // move in a compound plan. Keep them for Phase 2 even when another variant is
  // better for the individual recommendation list.
  const compoundTerminationMoves: Move[] = [];
  const compounds: CompoundPlan[] = [];
  const hireRecommendations: HireRecommendation[] = [];
  const otPolicyRecommendations: OtPolicyRecommendation[] = [];
  let solverRuns = 0;
  let consecutiveFailures = 0;
  let currentPhase = "screening";

  const emitProgress = async (label: string) => {
    if (signal?.aborted) throw new DOMException("Optimization aborted", "AbortError");
    onProgress?.({ phase: currentPhase, current: solverRuns, total: SOLVER_BUDGET, label });
    // Yield event loop so SSE events flush and server stays responsive
    await new Promise(r => setTimeout(r, 0));
  };

  // Dispatch independent what-if scenarios in bounded-concurrency chunks.
  // Mutates the closure-scoped solverRuns / consecutiveFailures so the budget
  // and circuit-break semantics match the sequential version: budget is
  // checked between chunks, consecutiveFailures resets on any success in a
  // chunk and increments by chunk size when every call in the chunk failed.
  async function runScreeningParallel<C>(
    candidates: C[],
    runOne: (c: C) => Promise<MultiWeekExtract>,
    cap: number,
  ): Promise<Array<{ candidate: C; result: MultiWeekExtract }>> {
    const out: Array<{ candidate: C; result: MultiWeekExtract }> = [];
    for (let i = 0; i < candidates.length; i += SCREENING_CONCURRENCY) {
      if (solverRuns >= cap || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      const remaining = cap - solverRuns;
      const chunk = candidates.slice(i, i + Math.min(SCREENING_CONCURRENCY, remaining));
      if (chunk.length === 0) break;
      if (signal?.aborted) throw new DOMException("Optimization aborted", "AbortError");
      const settled = await Promise.allSettled(chunk.map(runOne));
      let anySuccess = false;
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status === "fulfilled") {
          solverRuns++;
          anySuccess = true;
          out.push({ candidate: chunk[j], result: r.value });
        } else {
          if (r.reason instanceof DOMException && r.reason.name === "AbortError") throw r.reason;
        }
      }
      consecutiveFailures = anySuccess ? 0 : consecutiveFailures + chunk.length;
      await emitProgress(`Scénario ${solverRuns}/${SOLVER_BUDGET}…`);
    }
    return out;
  }

  try {
  // A) reduce_to_planned
  if (levers.has("reduce")) {
    await emitProgress("Test des réductions de contrat…");
    type ReduceCand = { w: WorkerLoad; overrides: Record<string, number>; contractH: number; proposedH: number; plannedH: number };
    const reduceCands: ReduceCand[] = [];
    for (const w of employmentActionWorkerLoads) {
      const contractH = w.contractHours ?? 35;
      const plannedH = baseWorkerHours.get(w.workerId) ?? 0;
      const roleCap = baseResult.capacity.find(c => c.role === w.role);
      const reduceThreshold = (roleCap?.hoursRatio ?? 1) > 1.3 ? 0.85 : 0.7;
      if (contractH <= 0 || plannedH >= contractH * reduceThreshold) continue;
      const proposedH = Math.max(Math.ceil(plannedH), 0);
      if (proposedH === 0 || proposedH === contractH) continue;
      reduceCands.push({ w, overrides: { [w.workerId]: proposedH }, contractH, proposedH, plannedH });
    }
    const results = await runScreeningParallel(reduceCands, c => runScenario(c.overrides), PHASE1_BUDGET_CAP);
    for (const { candidate, result } of results) {
      const { w, overrides, contractH, proposedH, plannedH } = candidate;
      const impact = computeImpact(result.avgWorkerHours, result.minFills, overrides);
      const score = scoreImpact(impact);
      const createsUnderstaffing = Object.values(impact.understaffedSlotsDelta).some(d => d > 0);
      if (score <= 0) continue;
      allMoves.push({
        rec: {
          id: `reduce_${w.workerId}`, type: "reduce_to_planned", label: "Ajuster le contrat",
          description: `Réduire le contrat de ${w.workerName} de ${contractH}h à ${proposedH}h (planifié : ${Math.round(plannedH)}h). Économise ${contractH - proposedH}h.`,
          workerId: w.workerId, workerName: w.workerName, role: w.role as "kitchen" | "floor", contractType: w.contractType,
          currentValue: contractH, proposedValue: proposedH, impact, score,
        },
        contractOverride: proposedH,
        compoundEligible: isPracticalContractReductionForCompound({ contractType: w.contractType, currentValue: contractH, proposedValue: proposedH }),
        displayEligible: !createsUnderstaffing,
      });
    }
  }

  // B) terminate
  if (levers.has("terminate")) {
    await emitProgress("Évaluation des suppressions de postes…");
    type TermCand = { w: WorkerLoad; overrides: Record<string, number>; maxWeeklyOverrides?: Record<string, number>; contractH: number; plannedH: number; mode: "plain" | "with39h" | "with46h"; compoundOnly?: boolean };
    const termCands: TermCand[] = [];

    function terminateWith39hOverrides(w: WorkerLoad): Record<string, number> | null {
      const overrides: Record<string, number> = { [w.workerId]: 0 };
      for (const mate of employmentActionWorkerLoads) {
        if (mate.workerId === w.workerId || mate.role !== w.role) continue;
        const mateContract = mate.contractHours ?? 35;
        if (mateContract >= 35 && mateContract < 39) overrides[mate.workerId] = 39;
      }
      return Object.keys(overrides).length > 1 ? overrides : null;
    }

    function terminateWith46hOtOverrides(w: WorkerLoad): Record<string, number> | null {
      const eligible = employmentActionWorkerLoads
        .filter(mate => mate.workerId !== w.workerId && mate.role === w.role && (mate.contractHours ?? 35) >= 35)
        .map(mate => {
          const prefs = workerOtPrefs.get(mate.workerId);
          const currentCap = prefs?.maxWeeklyHours ?? prefs?.adminOtOverride ?? otCapForMode(otMode, otWeeklyCap);
          return { mate, overtimeWilling: !!prefs?.overtimeWilling, currentCap };
        })
        .filter(x => x.currentCap < 46);
      const willing = eligible.filter(x => x.overtimeWilling);
      const pool = willing.length > 0 ? willing : eligible;
      const overrides: Record<string, number> = {};
      for (const { mate } of pool) overrides[mate.workerId] = 46;
      return Object.keys(overrides).length > 0 ? overrides : null;
    }

    for (const w of employmentActionWorkerLoads) {
      const contractH = w.contractHours ?? 35;
      const plannedH = baseWorkerHours.get(w.workerId) ?? 0;
      const roleRatio = baseResult.capacity.find(c => c.role === w.role)?.hoursRatio ?? 1;
      const severelyOverstaffed = roleRatio > 1.3;
      const roleOverstaffed = roleRatio > 1.2;
      const isTempContract = w.contractType === "CDD" || w.contractType === "saisonnier";
      const termThreshold = w.contractType === "saisonnier"
        ? (severelyOverstaffed ? 0.98 : roleOverstaffed ? 0.9 : 0.65)
        : w.contractType === "CDD"
          ? (severelyOverstaffed ? 0.85 : 0.65)
          : severelyOverstaffed ? 0.75 : roleOverstaffed ? 0.55 : 0.35;
      if (contractH <= 0 || plannedH >= contractH * termThreshold) continue;
      const uniqueSubRole = hasUniqueSubRole(w);
      const roleTeamSize = workerLoads.filter(mate => mate.role === w.role).length;
      // Small teams (e.g. 5-person kitchen) often genuinely cannot lose the
      // only holder of a sub-role. Larger, heavily overstaffed teams may be able
      // to replace that skill through a training move, so keep those as
      // compound-only search candidates instead of hiding the possibility.
      const compoundOnlyUnique = Boolean(uniqueSubRole && roleTeamSize > 5 && severelyOverstaffed);
      if (uniqueSubRole && !compoundOnlyUnique) continue;
      termCands.push({ w, overrides: { [w.workerId]: 0 }, contractH, plannedH, mode: "plain", compoundOnly: compoundOnlyUnique });
      const with39h = terminateWith39hOverrides(w);
      if (with39h) termCands.push({ w, overrides: with39h, contractH, plannedH, mode: "with39h", compoundOnly: compoundOnlyUnique });
      const with46h = terminateWith46hOtOverrides(w);
      if (with46h) termCands.push({ w, overrides: { [w.workerId]: 0 }, maxWeeklyOverrides: with46h, contractH, plannedH, mode: "with46h", compoundOnly: compoundOnlyUnique });
    }
    const termPriority = (c: TermCand) => {
      const roleRatio = baseResult.capacity.find(cap => cap.role === c.w.role)?.hoursRatio ?? 1;
      const utilization = c.contractH > 0 ? c.plannedH / c.contractH : 1;
      const contractBonus = c.w.contractType === "saisonnier" ? 30 : c.w.contractType === "CDD" ? 25 : 0;
      const modeBonus = c.mode === "plain" ? 3 : c.mode === "with39h" ? 2 : 1;
      return (roleRatio * 100) + ((1 - utilization) * 80) + contractBonus + modeBonus;
    };
    termCands.sort((a, b) => termPriority(b) - termPriority(a));
    if (termCands.length > Math.max(0, PHASE1_BUDGET_CAP - solverRuns)) {
      console.log(`[auto-optimize] terminate screening candidates ${termCands.length} exceed remaining Phase 1 budget ${Math.max(0, PHASE1_BUDGET_CAP - solverRuns)}; highest-priority candidates run first`);
    }
    const bestByWorker = new Map<string, Move>();
    const results = await runScreeningParallel(termCands, c => runScenario(c.overrides, undefined, undefined, undefined, undefined, undefined, c.maxWeeklyOverrides), PHASE1_BUDGET_CAP);
    for (const { candidate, result } of results) {
      const { w, overrides, maxWeeklyOverrides, contractH, plannedH, mode } = candidate;
      const impact = computeImpact(result.avgWorkerHours, result.minFills, overrides);
      const score = scoreImpact(impact);
      const createsUnderstaffing = Object.values(impact.understaffedSlotsDelta).some(d => d > 0);
      if (score <= 0) continue;
      const displayEligible = !candidate.compoundOnly && !createsUnderstaffing;
      const endNote = w.contractEndDate ? ` (fin de contrat : ${w.contractEndDate})` : "";
      const ctLabel = w.contractType === "CDD" ? "Ne pas renouveler le CDD" : w.contractType === "saisonnier" ? "Fin de contrat saisonnier" : "Retirer de l'effectif";
      const bumpSummary = formatContractBumpSummary(overrides, workerLoads, w.workerId);
      const overtimeSummary = formatMaxWeeklySummary(maxWeeklyOverrides, workerLoads);
      const bumpNote = bumpSummary
        ? ` Variante avec absorption simple : ${bumpSummary}, pour éviter de réduire fortement d'autres contrats.`
        : overtimeSummary
          ? ` Variante avec heures supplémentaires temporaires : ${overtimeSummary}, à valider et à surveiller sur la moyenne 12 semaines.`
          : "";
      const move: Move = {
        rec: {
          id: mode === "with39h" ? `terminate_${w.workerId}_with39h` : mode === "with46h" ? `terminate_${w.workerId}_with46h` : `terminate_${w.workerId}`,
          type: "terminate", label: ctLabel,
          description: `${w.workerName} n'est utilisé(e) qu'à ${Math.round((plannedH / contractH) * 100)}% (${Math.round(plannedH)}h/${contractH}h)${endNote}. Ce poste pourrait être supprimé — les heures sont redistribuées sur l'équipe.${bumpNote}`,
          workerId: w.workerId, workerName: w.workerName, role: w.role as "kitchen" | "floor", contractType: w.contractType,
          currentValue: contractH, proposedValue: 0, impact, score, contractOverrides: overrides, maxWeeklyOverrides,
        },
        contractOverrides: overrides,
        maxWeeklyOverrides,
        displayEligible,
      };

      compoundTerminationMoves.push(move);
      if (!displayEligible) continue;

      const existing = bestByWorker.get(w.workerId);
      if (!existing) {
        bestByWorker.set(w.workerId, move);
        continue;
      }
      const role = w.role;
      const existingFinalAbs = Math.abs(baseSurplus(role) + (existing.rec.impact.surplusHoursDelta[role] ?? 0));
      const candidateFinalAbs = Math.abs(baseSurplus(role) + (impact.surplusHoursDelta[role] ?? 0));
      const materiallyMoreBalanced = candidateFinalAbs + 1 < existingFinalAbs;
      if ((mode === "with39h" && materiallyMoreBalanced) || (!existing.rec.contractOverrides || Object.keys(existing.rec.contractOverrides).length <= 1) && move.rec.score > existing.rec.score) {
        bestByWorker.set(w.workerId, move);
      }
    }
    allMoves.push(...bestByWorker.values());
  }

  // C) remove_restrictions
  if (levers.has("remove_restrictions")) {
    await emitProgress("Analyse des restrictions…");
    type UnrestrictCand = { w: WorkerLoad; contractH: number; plannedH: number };
    const unrestrictCands: UnrestrictCand[] = [];
    for (const w of employmentActionWorkerLoads) {
      if (!workersWithRestrictions.has(w.workerId)) continue;
      const contractH = w.contractHours ?? 35;
      const plannedH = baseWorkerHours.get(w.workerId) ?? 0;
      if (contractH <= 0 || plannedH >= contractH * 0.9) continue;
      unrestrictCands.push({ w, contractH, plannedH });
    }
    const results = await runScreeningParallel(unrestrictCands, c => runScenario(undefined, [c.w.workerId]), PHASE1_BUDGET_CAP);
    for (const { candidate, result } of results) {
      const { w, contractH, plannedH } = candidate;
      const impact = computeImpact(result.avgWorkerHours, result.minFills);
      const score = scoreImpact(impact);
      if (impact.affectedWorkers.length === 0) continue;
      allMoves.push({
        rec: {
          id: `unrestrict_${w.workerId}`, type: "remove_restrictions", label: "Lever les restrictions",
          description: `Supprimer les restrictions de ${w.workerName} permettrait de mieux l'utiliser (${Math.round(plannedH)}h → potentiellement ${contractH}h).`,
          workerId: w.workerId, workerName: w.workerName, role: w.role as "kitchen" | "floor", contractType: w.contractType,
          currentValue: Math.round(plannedH), proposedValue: contractH, impact, score,
        },
        restrictionOverride: true,
      });
    }
  }

  // D) increase_hours — suggest increasing contract for workers planned above their contract
  if (levers.has("increase")) {
    await emitProgress("Test des augmentations de contrat…");
    type IncreaseCand = { w: WorkerLoad; overrides: Record<string, number>; contractH: number; proposedH: number; plannedH: number };
    const increaseCands: IncreaseCand[] = [];
    for (const w of employmentActionWorkerLoads) {
      const contractH = w.contractHours ?? 35;
      const plannedH = baseWorkerHours.get(w.workerId) ?? 0;
      if (contractH >= 39 || contractH <= 0 || plannedH <= contractH * 1.05) continue;
      const proposedH = Math.min(39, Math.ceil(plannedH));
      if (proposedH <= contractH) continue;
      increaseCands.push({ w, overrides: { [w.workerId]: proposedH }, contractH, proposedH, plannedH });
    }
    const results = await runScreeningParallel(increaseCands, c => runScenario(c.overrides), PHASE1_BUDGET_CAP);
    for (const { candidate, result } of results) {
      const { w, overrides, contractH, proposedH, plannedH } = candidate;
      const impact = computeImpact(result.avgWorkerHours, result.minFills, overrides);
      const score = scoreImpact(impact);
      // For increase, we accept slight surplus increase — the goal is reducing OT cost
      if (Object.values(impact.understaffedSlotsDelta).some(d => d > 0)) continue;
      allMoves.push({
        rec: {
          id: `increase_${w.workerId}`, type: "increase_hours", label: "Augmenter le contrat",
          description: `Augmenter le contrat de ${w.workerName} de ${contractH}h à ${proposedH}h (planifié : ${Math.round(plannedH)}h). Réduit les heures supplémentaires de ${proposedH - contractH}h.`,
          workerId: w.workerId, workerName: w.workerName, role: w.role as "kitchen" | "floor", contractType: w.contractType,
          currentValue: contractH, proposedValue: proposedH, impact, score,
        },
        contractOverride: proposedH,
      });
    }
  }

  // E) intra_train — suggest expanding sub-roles within same department to unlock better utilization
  if (levers.has("intra_train") && hasSubRoles) {
    await emitProgress("Test des formations intra-rôle…");
    type IntraCand = {
      w: WorkerLoad; targetSubRole: string; hierarchy: readonly string[]; contractH: number;
      targetIdx: number; trainingUp: boolean; coveringCount: number;
    };
    const intraCands: IntraCand[] = [];
    for (const role of ["kitchen", "floor"] as const) {
      const cap = baseResult.capacity.find(c => c.role === role);
      if (!cap || cap.surplusHours <= 20) continue;
      const hierarchy = role === "kitchen" ? KITCHEN_HIERARCHY : SALLE_HIERARCHY;
      const configured = configuredSubRolesFor(role);
      if (configured.size === 0) continue;
      const roleWorkers = employmentActionWorkerLoads.filter(w => w.role === role);
      for (const targetSubRole of hierarchy) {
        if (!configured.has(targetSubRole)) continue;
        const coveringWorkers = workerLoads.filter(w => w.role === role && w.subRoles.includes(targetSubRole));
        if (coveringWorkers.length >= 3) continue;
        const cands = roleWorkers
          .filter(w => !w.subRoles.includes(targetSubRole) && (baseWorkerHours.get(w.workerId) ?? 0) < (w.contractHours ?? 35) * 0.85)
          .sort((a, b) => {
            const aMinDist = Math.min(...a.subRoles.map(sr => Math.abs(hierarchy.indexOf(sr) - hierarchy.indexOf(targetSubRole))).filter(d => d >= 0));
            const bMinDist = Math.min(...b.subRoles.map(sr => Math.abs(hierarchy.indexOf(sr) - hierarchy.indexOf(targetSubRole))).filter(d => d >= 0));
            return aMinDist - bMinDist;
          })
          .slice(0, 3);
        for (const w of cands) {
          const contractH = w.contractHours ?? 35;
          const targetIdx = hierarchy.indexOf(targetSubRole);
          const currentBestRank = Math.min(...w.subRoles.map(sr => { const i = hierarchy.indexOf(sr); return i >= 0 ? i : hierarchy.length; }));
          const trainingUp = targetIdx < currentBestRank;
          intraCands.push({ w, targetSubRole, hierarchy, contractH, targetIdx, trainingUp, coveringCount: coveringWorkers.length });
        }
      }
    }
    const results = await runScreeningParallel(
      intraCands,
      c => runScenario(undefined, undefined, undefined, { [c.w.workerId]: [c.targetSubRole] }, undefined, baselineSlotFillFloors),
      PHASE1_BUDGET_CAP,
    );
    for (const { candidate, result } of results) {
      const { w, targetSubRole, hierarchy, contractH, targetIdx, trainingUp, coveringCount } = candidate;
      const impact = computeImpact(result.avgWorkerHours, result.minFills);
      allMoves.push({
        rec: {
          id: `intratrain_${w.workerId}_${targetSubRole}`, type: "intra_train",
          label: `Former en ${targetSubRole}`,
          description: `Former ${w.workerName} (${w.subRoles.join(", ")}) pour couvrir le poste ${targetSubRole}. ${trainingUp ? "Promotion / formation qualifiante." : "Changement vers un poste moins qualifié — à valider humainement."}${coveringCount <= 1 ? " Renforcerait une couverture fragile." : ""}`,
          workerId: w.workerId, workerName: w.workerName, role: w.role as "kitchen" | "floor", contractType: w.contractType,
          currentValue: contractH, proposedValue: targetIdx, impact,
          score: scoreImpact(impact) + (trainingUp ? 5 : -10),
          trainingFromRole: bestSubRole(w.workerId, hierarchy),
          trainingToRole: targetSubRole,
        },
        subRoleOverride: { workerId: w.workerId, addRoles: [targetSubRole] },
      });
    }
  }

  // F) cross_train
  const kitchenCap = baseResult.capacity.find(c => c.role === "kitchen");
  const salleCap = baseResult.capacity.find(c => c.role === "floor");
  if (kitchenCap && salleCap && levers.has("cross_train")) {
    await emitProgress("Test de la polyvalence…");
    const imbalances: Array<{ from: "kitchen" | "floor"; to: "kitchen" | "floor" }> = [];
    const kVerdict = contractVerdict("kitchen");
    const sVerdict = contractVerdict("floor");
    if (kitchenCap.surplusHours > 0 && (sVerdict === "undersized" || sVerdict === "tight"))
      imbalances.push({ from: "kitchen", to: "floor" });
    if (salleCap.surplusHours > 0 && (kVerdict === "undersized" || kVerdict === "tight"))
      imbalances.push({ from: "floor", to: "kitchen" });
    type CrossCand = { w: WorkerLoad; from: "kitchen" | "floor"; to: "kitchen" | "floor"; roleOvr: Record<string, string>; contractH: number; plannedH: number };
    const crossCands: CrossCand[] = [];
    for (const { from, to } of imbalances) {
      const cands = employmentActionWorkerLoads
        .filter(w => w.role === from && (w.contractHours ?? 35) > 0 && (baseWorkerHours.get(w.workerId) ?? 0) < (w.contractHours ?? 35) * 0.7)
        .sort((a, b) => ((baseWorkerHours.get(a.workerId) ?? 0) / (a.contractHours || 35)) - ((baseWorkerHours.get(b.workerId) ?? 0) / (b.contractHours || 35)));
      for (const w of cands) {
        const contractH = w.contractHours ?? 35;
        const plannedH = baseWorkerHours.get(w.workerId) ?? 0;
        crossCands.push({ w, from, to, roleOvr: { [w.workerId]: to }, contractH, plannedH });
      }
    }
    const results = await runScreeningParallel(crossCands, c => runScenario(undefined, undefined, c.roleOvr), PHASE1_BUDGET_CAP);
    for (const { candidate, result } of results) {
      const { w, from, to, roleOvr, contractH, plannedH } = candidate;
      const impact = computeImpact(result.avgWorkerHours, result.minFills, undefined, roleOvr);
      const score = scoreImpact(impact);
      if (score <= 0 || (impact.understaffedSlotsDelta[from] ?? 0) > 0) continue;
      const toLabel = to === "kitchen" ? "cuisine" : "floor";
      const fromLabel = from === "kitchen" ? "cuisine" : "floor";
      allMoves.push({
        rec: {
          id: `crosstrain_${w.workerId}`, type: "cross_train", label: `Transférer en ${toLabel}`,
          description: `Transférer ${w.workerName} de ${fromLabel} vers ${toLabel} (${Math.round(plannedH)}h/${contractH}h). Renforcerait l'équipe ${toLabel}.`,
          workerId: w.workerId, workerName: w.workerName, role: w.role as "kitchen" | "floor", contractType: w.contractType,
          currentValue: contractH, proposedValue: contractH, impact, score,
          trainingFromRole: bestSubRole(w.workerId, from === "kitchen" ? KITCHEN_HIERARCHY : SALLE_HIERARCHY),
          trainingToRole: to,
        },
        roleOverride: to,
      });
    }
  }

  console.log(`[auto-optimize] Phase 1 done: ${allMoves.length} moves found, ${solverRuns} solver runs used${roleFilter ? ` (filter: ${roleFilter})` : ""}`);

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Greedy compound building
  // ═══════════════════════════════════════════════════════════════
  currentPhase = "compound";
  await emitProgress("Construction du plan optimal…");

  async function buildCompound(candidateMoves: Move[], id: string, label: string, runCap = PHASE2_BUDGET_CAP): Promise<CompoundPlan | null> {
    if (candidateMoves.length === 0) return null;
    const applied: Move[] = [];
    let bestScore = scorePerfection({ surplusHoursDelta: {}, understaffedSlotsDelta: {}, hoursRedistributed: 0, affectedWorkers: [] }, []);
    let bestImpact: OptimizeImpact | null = null;
    let noImprovementStreak = 0;

    // Net expected perfection-points gain after paying the move's cost. Using a
    // ratio (score / cost) buried high-impact reductions (large score, large
    // cost) behind cheap training moves (small score, near-zero cost) — the
    // no-improvement streak then exited before reductions ever got a turn on a
    // heavily-overstaffed role.
    const moveEfficiency = (m: Move) => m.rec.score - moveCost(m);
    const isTerminateAbsorptionVariant = (m: Move) => m.rec.type === "terminate" && (
      Object.keys(moveMaxWeeklyOverrides(m)).length > 0 || Object.keys(moveContractOverrides(m)).length > 1
    );
    const eligibleMoves = candidateMoves.filter(m => m.compoundEligible !== false);
    const baseSorted = eligibleMoves
      .filter(m => !isTerminateAbsorptionVariant(m))
      .sort((a, b) => moveEfficiency(b) - moveEfficiency(a));
    const absorptionByWorker = new Map<string, Move[]>();
    for (const m of eligibleMoves.filter(isTerminateAbsorptionVariant)) {
      const arr = absorptionByWorker.get(m.rec.workerId) ?? [];
      arr.push(m);
      absorptionByWorker.set(m.rec.workerId, arr);
    }
    const sorted: Move[] = [];
    const pushed = new Set<string>();
    const pushMove = (m: Move) => {
      if (pushed.has(m.rec.id)) return;
      sorted.push(m);
      pushed.add(m.rec.id);
    };
    for (const move of baseSorted) {
      pushMove(move);
      if (move.rec.type === "terminate") {
        for (const variant of (absorptionByWorker.get(move.rec.workerId) ?? []).sort((a, b) => moveEfficiency(b) - moveEfficiency(a))) pushMove(variant);
      }
    }
    for (const variants of absorptionByWorker.values()) {
      for (const variant of variants.sort((a, b) => moveEfficiency(b) - moveEfficiency(a))) pushMove(variant);
    }

    const aggregateMoveState = (moves: Move[]) => {
      const contract: Record<string, number> = {};
      const maxWeekly: Record<string, number> = {};
      const restrictions: string[] = [];
      const roles: Record<string, string> = {};
      const subRoles: Record<string, string[]> = {};
      for (const move of moves) {
        Object.assign(contract, moveContractOverrides(move));
        Object.assign(maxWeekly, moveMaxWeeklyOverrides(move));
        if (move.restrictionOverride) restrictions.push(move.rec.workerId);
        if (move.roleOverride) roles[move.rec.workerId] = move.roleOverride;
        if (move.subRoleOverride) {
          const existing = subRoles[move.subRoleOverride.workerId] ?? [];
          subRoles[move.subRoleOverride.workerId] = [...new Set([...existing, ...move.subRoleOverride.addRoles])];
        }
      }
      for (const [workerId, contractHours] of Object.entries(contract)) {
        if (contractHours <= 0) delete maxWeekly[workerId];
      }
      return { contract, maxWeekly, restrictions, roles, subRoles };
    };

    const buildPlan = (planMoves: Move[], impact: OptimizeImpact, score: number, planId = id, planLabel = label): CompoundPlan => {
      const nReduce = planMoves.filter(m => m.rec.type === "reduce_to_planned").length;
      const nIncrease = planMoves.filter(m => m.rec.type === "increase_hours").length;
      const nTerminate = planMoves.filter(m => m.rec.type === "terminate").length;
      const nUnrestrict = planMoves.filter(m => m.rec.type === "remove_restrictions").length;
      const nCrossTrain = planMoves.filter(m => m.rec.type === "cross_train").length;
      const nIntraTrain = planMoves.filter(m => m.rec.type === "intra_train").length;
      const parts: string[] = [];
      if (nReduce) parts.push(`${nReduce} réduction${nReduce > 1 ? "s" : ""} de contrat`);
      if (nIncrease) parts.push(`${nIncrease} augmentation${nIncrease > 1 ? "s" : ""} de contrat`);
      if (nTerminate) parts.push(`${nTerminate} poste${nTerminate > 1 ? "s" : ""} supprimé${nTerminate > 1 ? "s" : ""}`);
      if (nUnrestrict) parts.push(`${nUnrestrict} restriction${nUnrestrict > 1 ? "s" : ""} levée${nUnrestrict > 1 ? "s" : ""}`);
      if (nCrossTrain) parts.push(`${nCrossTrain} transfert${nCrossTrain > 1 ? "s" : ""} de département`);
      if (nIntraTrain) parts.push(`${nIntraTrain} formation${nIntraTrain > 1 ? "s" : ""} intra-rôle`);
      const totalSaved = -Object.values(impact.surplusHoursDelta).reduce((s, d) => s + d, 0);

      const finalState: Record<string, { surplus: number; understaffed: number; verdict: string }> = {};
      for (const role of ["kitchen", "floor"]) {
        const finalSurplus = baseSurplus(role) + (impact.surplusHoursDelta[role] ?? 0);
        const finalUnderstaffed = baseUnderstaffed(role) + (impact.understaffedSlotsDelta[role] ?? 0);
        finalState[role] = {
          surplus: finalSurplus,
          understaffed: Math.max(0, finalUnderstaffed),
          verdict: (() => {
            const cap = baseResult.capacity.find(c => c.role === role);
            const otBuffer = cap?.otCapacityHours ?? 0;
            if (finalUnderstaffed > 0) return "undersized";
            if (finalSurplus < 0 && Math.abs(finalSurplus) > otBuffer) return "undersized";
            if (finalSurplus > 15) return "oversized";
            return "balanced";
          })(),
        };
      }

      return {
        id: planId,
        label: planLabel,
        description: `${parts.length > 0 ? parts.join(", ") : "Ajustements limités"}. Économie de ${totalSaved}h de surplus/semaine.`,
        moveIds: planMoves.map(m => m.rec.id),
        actions: planMoves.map(m => m.rec),
        totalImpact: impact,
        totalScore: score,
        finalState,
      };
    };

    const runPlanForMoves = async (moves: Move[]): Promise<{ impact: OptimizeImpact; score: number } | null> => {
      if (solverRuns >= PHASE2_BUDGET_CAP || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
      const state = aggregateMoveState(moves);
      const hasSubRoleChanges = Object.keys(state.subRoles).length > 0;
      try {
        const { avgWorkerHours, minFills } = await runScenario(
          Object.keys(state.contract).length > 0 ? state.contract : undefined,
          state.restrictions.length > 0 ? state.restrictions : undefined,
          Object.keys(state.roles).length > 0 ? state.roles : undefined,
          hasSubRoleChanges ? state.subRoles : undefined,
          undefined,
          hasSubRoleChanges ? baselineSlotFillFloors : undefined,
          Object.keys(state.maxWeekly).length > 0 ? state.maxWeekly : undefined,
        );
        const impact = computeImpact(avgWorkerHours, minFills, state.contract, state.roles);
        const score = scorePerfection(impact, moves);
        solverRuns++; consecutiveFailures = 0; await emitProgress(`Scénario ${solverRuns}/${SOLVER_BUDGET}…`);
        return { impact, score };
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        consecutiveFailures++;
        return null;
      }
    };

    const tryApplyMove = async (move: Move, countNoImprovement: boolean): Promise<boolean> => {
      if (solverRuns >= runCap || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

      const moveContractIds = new Set(Object.keys(moveContractOverrides(move)));
      const moveMaxWeekly = moveMaxWeeklyOverrides(move);
      // A terminate can replace a prior contract-modifying move on the same
      // worker (the old reduce/contract change is dropped). Other combinations
      // of moves on the same primary worker are nonsensical — e.g. training
      // someone you're about to fire — and must be rejected.
      const existingReduceIdx = move.rec.type === "terminate"
        ? applied.findIndex(a => a.rec.workerId === move.rec.workerId && Object.keys(moveContractOverrides(a)).length > 0)
        : -1;
      const conflict = applied.some((a, idx) => {
        if (a.rec.workerId === move.rec.workerId && idx !== existingReduceIdx) return true;
        const contractOverlap = Object.keys(moveContractOverrides(a)).some(workerId => moveContractIds.has(workerId));
        if (idx !== existingReduceIdx && contractOverlap) return true;
        return Object.entries(moveMaxWeeklyOverrides(a)).some(([workerId, cap]) => {
          const proposed = moveMaxWeekly[workerId];
          return proposed !== undefined && proposed !== cap;
        });
      });
      if (conflict) return false;

      const trialMoves = existingReduceIdx >= 0
        ? [...applied.slice(0, existingReduceIdx), ...applied.slice(existingReduceIdx + 1), move]
        : [...applied, move];
      const state = aggregateMoveState(trialMoves);

      try {
        // Pass baseline fill floors when the compound includes sub-role changes
        const hasSubRoleChanges = Object.keys(state.subRoles).length > 0;
        const { avgWorkerHours, minFills } = await runScenario(
          Object.keys(state.contract).length > 0 ? state.contract : undefined,
          state.restrictions.length > 0 ? state.restrictions : undefined,
          Object.keys(state.roles).length > 0 ? state.roles : undefined,
          hasSubRoleChanges ? state.subRoles : undefined,
          undefined,
          hasSubRoleChanges ? baselineSlotFillFloors : undefined,
          Object.keys(state.maxWeekly).length > 0 ? state.maxWeekly : undefined,
        );
        const impact = computeImpact(avgWorkerHours, minFills, state.contract, state.roles);
        const score = scorePerfection(impact, trialMoves);
        solverRuns++; consecutiveFailures = 0; await emitProgress(`Scénario ${solverRuns}/${SOLVER_BUDGET}…`);

        if (score > bestScore) {
          if (existingReduceIdx >= 0) applied.splice(existingReduceIdx, 1);
          applied.push(move);
          bestScore = score;
          bestImpact = impact;
          noImprovementStreak = 0;
          return true;
        }
        if (countNoImprovement) noImprovementStreak++;
        return false;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        if (countNoImprovement) noImprovementStreak++;
        consecutiveFailures++;
        return false;
      }
    };

    for (const move of sorted) {
      if (solverRuns >= runCap || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      if (noImprovementStreak >= MAX_COMPOUND_NO_IMPROVEMENT_STREAK) break;
      await tryApplyMove(move, true);
    }

    if (applied.length === 0 || !bestImpact) return null;
    let selectedPlan = buildPlan(applied, bestImpact, bestScore);

    const rankRolesForPlan = roleFilter ? [roleFilter] : ["kitchen", "floor"];
    const isLeanButRisky = rankRolesForPlan.some(role => {
      const state = selectedPlan.finalState?.[role];
      if (!state) return false;
      const createdUnderstaffing = Math.max(0, bestImpact?.understaffedSlotsDelta[role] ?? 0);
      return state.surplus <= 20 && (state.understaffed >= 4 || createdUnderstaffing >= 4);
    });

    if (isLeanButRisky) {
      const removalUndoPriority = (m: Move) => {
        const coverageDamage = rankRolesForPlan.reduce((sum, role) => sum + Math.max(0, m.rec.impact.understaffedSlotsDelta[role] ?? 0), 0);
        const hoursRemoved = Math.max(0, m.rec.currentValue - m.rec.proposedValue);
        return (coverageDamage * 1000) + (moveCost(m) * 10) + hoursRemoved;
      };
      const undoCandidates = applied
        .filter(m => m.rec.type === "terminate" || m.rec.type === "reduce_to_planned")
        .sort((a, b) => removalUndoPriority(b) - removalUndoPriority(a))
        .slice(0, 3);
      const currentRank = () => computePlanRankScore({ plan: selectedPlan, otCapacityByRole, roles: rankRolesForPlan });
      for (const undo of undoCandidates) {
        if (solverRuns >= PHASE2_BUDGET_CAP || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
        const altMoves = applied.filter(m => m !== undo);
        if (altMoves.length === applied.length) continue;
        const alt = await runPlanForMoves(altMoves);
        if (!alt) continue;
        const altPlan = buildPlan(altMoves, alt.impact, alt.score, `${id}_without_${undo.rec.id}`, label);
        if (computePlanRankScore({ plan: altPlan, otCapacityByRole, roles: rankRolesForPlan }) > currentRank()) {
          selectedPlan = altPlan;
        }
      }
    }

    const baseUnderstaffedByRole = Object.fromEntries(rankRolesForPlan.map(role => [role, baseUnderstaffed(role)]));
    const planOtCapacityByRole = Object.fromEntries(rankRolesForPlan.map(role => [
      role,
      baseResult.capacity.find(c => c.role === role)?.otCapacityHours ?? 0,
    ]));
    if (planWorsensUnderstaffing({ plan: selectedPlan, baseUnderstaffedByRole, otCapacityByRole: planOtCapacityByRole, roles: rankRolesForPlan })) return null;

    return selectedPlan;
  }

  const candidateCompounds: CompoundPlan[] = [];
  const compoundMoves = [...allMoves.filter(m => m.rec.type !== "terminate"), ...compoundTerminationMoves];
  const conservativeMoves = compoundMoves.filter(m => m.rec.type !== "terminate");
  const hasTerminateMoves = compoundMoves.some(m => m.rec.type === "terminate");
  const phase2StartRuns = solverRuns;
  const phase2Remaining = Math.max(0, PHASE2_BUDGET_CAP - phase2StartRuns);
  const reserveForConservative = hasTerminateMoves && conservativeMoves.length > 0
    ? Math.floor(phase2Remaining * 0.35)
    : 0;
  const restructuringCap = PHASE2_BUDGET_CAP - reserveForConservative;
  const otCapacityByRole = Object.fromEntries(["kitchen", "floor"].map(role => [
    role,
    baseResult.capacity.find(c => c.role === role)?.otCapacityHours ?? 0,
  ]));
  const rankRoles = roleFilter ? [roleFilter] : ["kitchen", "floor"];

  if (hasTerminateMoves) {
    try {
      // Run the unrestricted/restructuring plan first. v0.2.36 built the
      // conservative plan first; on busy teams that could consume Phase 2's cap
      // before any termination/restructure compound was tested.
      const planB = await buildCompound(compoundMoves, "plan_restructuration", "Plan avec restructuration", restructuringCap);
      if (planB) candidateCompounds.push(planB);
    } catch (e) { console.error("Compound plan_restructuration failed:", e); }
  }

  try {
    const planA = await buildCompound(
      conservativeMoves,
      hasTerminateMoves ? "plan_sans_suppression" : "plan_optimal",
      hasTerminateMoves ? "Plan sans suppression de poste" : "Plan optimal",
      PHASE2_BUDGET_CAP,
    );
    if (planA) candidateCompounds.push(planA);
  } catch (e) { console.error("Compound plan_sans_suppression failed:", e); }

  if (candidateCompounds.length > 0) {
    const best = [...candidateCompounds].sort((a, b) => computePlanRankScore({ plan: b, otCapacityByRole, roles: rankRoles }) - computePlanRankScore({ plan: a, otCapacityByRole, roles: rankRoles }))[0];
    compounds.push(best);
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase 3: Hire estimation
  // ═══════════════════════════════════════════════════════════════
  if (levers.has("hire_cdi") || levers.has("hire_seasonal")) {
    currentPhase = "hire";
    await emitProgress("Estimation des recrutements…");
    const bestCompound = compounds.length > 0 ? compounds[compounds.length - 1] : null;
    const dayLabels: Record<number, string> = { 1: "Lundi", 2: "Mardi", 3: "Mercredi", 4: "Jeudi", 5: "Vendredi", 6: "Samedi", 7: "Dimanche" };

    for (const role of ["kitchen", "floor"] as const) {
      const finalSurplus = bestCompound
        ? baseSurplus(role) + (bestCompound.totalImpact.surplusHoursDelta[role] ?? 0)
        : baseSurplus(role);
      const finalUnderstaffed = bestCompound
        ? baseUnderstaffed(role) + (bestCompound.totalImpact.understaffedSlotsDelta[role] ?? 0)
        : baseUnderstaffed(role);

      // Skip only if comfortably balanced (>25% surplus buffer and no understaffed slots)
      const roleCap = baseResult.capacity.find(c => c.role === role);
      const surplusRatio = roleCap && roleCap.totalDemandHours > 0
        ? finalSurplus / roleCap.totalDemandHours : 1;
      const isComfortable = finalSurplus > 0 && surplusRatio > 0.1 && finalUnderstaffed <= 0;
      if (isComfortable) continue;

      const deficitH = finalSurplus < 0 ? Math.abs(finalSurplus) : 0;
      const isTight = finalSurplus >= 0 && (surplusRatio <= 0.1 || finalUnderstaffed > 0);
      const roleLabel = role === "kitchen" ? "cuisine" : "floor";
      const roleAvgRate = avgRateForRole(role);

      // Helper: analyze what the solver actually assigned to virtual workers
      function analyzeVirtualAssignments(
        virtualIds: string[],
        result: Awaited<ReturnType<typeof runHireScenario>>,
      ) {
        const slotMap = new Map(result.slots.map(s => [s.id, s]));
        const profiles: Array<{
          hours: number;
          days: Map<number, Set<string>>; // dow -> zones
          subRolesUsed: Set<string>;
        }> = [];
        for (const vId of virtualIds) {
          const vAssignments = result.assignments.filter(a => a.workerId === vId);
          const days = new Map<number, Set<string>>();
          const subRolesUsed = new Set<string>();
          for (const a of vAssignments) {
            const slot = slotMap.get(a.slotId);
            if (!slot) continue;
            if (!days.has(slot.dow)) days.set(slot.dow, new Set());
            days.get(slot.dow)!.add(slot.zone);
            if (slot.roleBreakdown) {
              for (const sr of Object.keys(slot.roleBreakdown)) subRolesUsed.add(sr);
            }
          }
          const avgH = result.avgWorkerHours.get(vId) ?? 0;
          if (avgH > 0) profiles.push({ hours: avgH, days, subRolesUsed });
        }
        return profiles;
      }

      function hireLaborImpact(
        result: Awaited<ReturnType<typeof runHireScenario>>,
        virtualIds: string[],
        paidWeeklyHours: number,
      ) {
        let otHoursReduced = 0;
        let otCostReducedWeekly = 0;
        for (const w of workerLoads.filter(w => w.role === role)) {
          const rate = workerRateByIdCents.get(w.workerId) ?? roleAvgRate;
          const before = baseWorkerHours.get(w.workerId) ?? 0;
          const after = result.avgWorkerHours.get(w.workerId) ?? 0;
          otHoursReduced += Math.max(0, overtimeHours(before) - overtimeHours(after));
          otCostReducedWeekly += Math.max(0, weeklyOvertimeCostCents(before, rate) - weeklyOvertimeCostCents(after, rate));
        }
        const newHireCostWeekly = virtualIds.reduce((sum, vId) => {
          const actual = result.avgWorkerHours.get(vId) ?? 0;
          const paid = Math.max(paidWeeklyHours, actual);
          return sum + weeklyLaborCostCents(paid, roleAvgRate);
        }, 0);
        return {
          analysisWeeks: NUM_WEEKS,
          overtimeHoursReducedPerWeek: Math.round(otHoursReduced * 10) / 10,
          overtimeCostReducedCents: Math.round(otCostReducedWeekly * NUM_WEEKS),
          newHireCostCents: Math.round(newHireCostWeekly * NUM_WEEKS),
          netLaborSavingsCents: Math.round((otCostReducedWeekly - newHireCostWeekly) * NUM_WEEKS),
        };
      }

      function hireSlotsAndProfile(
        result: Awaited<ReturnType<typeof runHireScenario>>,
        virtualIds: string[],
      ) {
        const slotMap = new Map(result.slots.map(s => [s.id, s]));
        const byKey = new Map<string, {
          day: number;
          dayLabel: string;
          zone: string;
          startTime: string;
          endTime: string;
          subRoles: Set<string>;
          currentFill: number;
          target: number;
          score: number;
        }>();
        for (const a of result.assignments) {
          if (!virtualIds.includes(a.workerId)) continue;
          const slot = slotMap.get(a.slotId);
          if (!slot || slot.role !== role) continue;
          const baseKey = `${slot.dow}_${slot.role}_${slot.zone}`;
          const currentFill = baseMinFills.get(baseKey) ?? slot.existingFill;
          const shortage = Math.max(0, slot.target - currentFill);
          const key = `${slot.dow}_${slot.zone}_${slot.startTime}_${slot.endTime}`;
          const entry = byKey.get(key) ?? {
            day: slot.dow,
            dayLabel: dayLabels[slot.dow] ?? `Jour ${slot.dow}`,
            zone: slot.zone,
            startTime: slot.startTime,
            endTime: slot.endTime,
            subRoles: new Set<string>(),
            currentFill,
            target: slot.target,
            score: 0,
          };
          if (slot.roleBreakdown) {
            for (const sr of Object.keys(slot.roleBreakdown)) entry.subRoles.add(sr);
          }
          entry.currentFill = Math.min(entry.currentFill, currentFill);
          entry.target = Math.max(entry.target, slot.target);
          entry.score += shortage * 100 + slot.target;
          byKey.set(key, entry);
        }
        const neededSlots = [...byKey.values()]
          .sort((a, b) => b.score - a.score || a.day - b.day || a.startTime.localeCompare(b.startTime))
          .slice(0, 8)
          .map(s => ({
            day: s.day,
            dayLabel: s.dayLabel,
            zone: s.zone,
            startTime: s.startTime,
            endTime: s.endTime,
            subRoles: [...s.subRoles],
            currentFill: s.currentFill,
            target: s.target,
          }));
        const days = [...new Set(neededSlots.map(s => s.dayLabel))];
        const zones = [...new Set(neededSlots.map(s => s.zone))];
        const subRoles = [...new Set(neededSlots.flatMap(s => s.subRoles ?? []))];
        const zoneText = zones.join(" ").toLowerCase();
        const pattern: NonNullable<HireRecommendation["idealProfile"]>["pattern"] = zoneText.includes("coupure")
          ? "coupure"
          : zoneText.includes("soir")
            ? (zoneText.includes("midi") ? "mixte" : "soir")
            : zoneText.includes("midi") ? "midi" : "mixte";
        return { neededSlots, idealProfile: { pattern, days, zones, subRoles } };
      }

      function describeProfile(p: { hours: number; days: Map<number, Set<string>>; subRolesUsed: Set<string> }) {
        const parts: string[] = [];
        parts.push(`~${Math.round(p.hours)}h/sem`);
        const dayList = [...p.days.keys()].sort().map(d => {
          const zones = [...p.days.get(d)!];
          return `${dayLabels[d] ?? "J" + d} (${zones.join("+")})`;
        });
        if (dayList.length > 0) parts.push(dayList.join(", "));
        if (p.subRolesUsed.size > 0) parts.push(`poste : ${[...p.subRolesUsed].join(", ")}`);
        return parts.join(" — ");
      }

      // CDI: inject one 35h virtual worker per role, all sub-roles, full availability
      if (levers.has("hire_cdi") && solverRuns < PHASE3_BUDGET_CAP) {
        const contractH = 35;
        const count = Math.max(1, Math.ceil(deficitH / contractH));
        const virtuals = Array.from({ length: count }, (_, i) => ({
          id: `virtual_cdi_${role}_${i}`, name: `Nouveau CDI ${roleLabel} ${i + 1}`,
          role, contractHours: contractH,
        }));
        try {
          const result = await runHireScenario(virtuals);
          const impact = computeImpact(result.avgWorkerHours, result.minFills);
          solverRuns++; consecutiveFailures = 0; await emitProgress(`Scénario ${solverRuns}/${SOLVER_BUDGET}…`);
          const profiles = analyzeVirtualAssignments(virtuals.map(v => v.id), result);
          const profileDesc = profiles.length > 0
            ? profiles.map((p, i) => `${profiles.length > 1 ? `#${i + 1} : ` : ""}${describeProfile(p)}`).join(" | ")
            : "aucune affectation";
          const { neededSlots, idealProfile } = hireSlotsAndProfile(result, virtuals.map(v => v.id));
          const labor = hireLaborImpact(result, virtuals.map(v => v.id), contractH);
          const laborDesc = labor.overtimeHoursReducedPerWeek > 0
            ? ` Réduit environ ${labor.overtimeHoursReducedPerWeek}h d'heures sup/semaine. Solde salarial estimé sur ${labor.analysisWeeks} semaines : ${labor.netLaborSavingsCents >= 0 ? "+" : ""}${Math.round(labor.netLaborSavingsCents / 100)}€ (HS évitées ${Math.round(labor.overtimeCostReducedCents / 100)}€ vs coût contrat ${Math.round(labor.newHireCostCents / 100)}€).`
            : "";
          const hireLabel = isTight
            ? `Renfort CDI ${roleLabel} (marge faible)`
            : `Embaucher ${count} CDI ${roleLabel}`;
          const hireDesc = isTight
            ? `Recruter 1 CDI ${contractH}h pour sécuriser la ${roleLabel} — la marge actuelle est trop faible (${Math.round(surplusRatio * 100)}% de surplus). Profil idéal : ${profileDesc}.${laborDesc}`
            : `Recruter ${count} CDI ${contractH}h pour la ${roleLabel}. Profil idéal : ${profileDesc}.${laborDesc}`;
          hireRecommendations.push({
            id: `hire_cdi_${role}`, type: "hire_cdi",
            label: hireLabel,
            description: hireDesc,
            role, contractHours: contractH, neededSlots, idealProfile, ...labor, score: Math.abs(scoreImpact(impact)),
          });
        } catch (e) { if (e instanceof DOMException && e.name === "AbortError") throw e; consecutiveFailures++; }
      }

      // Saisonnier: flexible buffer — for tight depts use 20h available, for deficit use actual deficit
      if (levers.has("hire_seasonal") && solverRuns < PHASE3_BUDGET_CAP) {
        const contractH = isTight ? 20 : Math.min(35, Math.max(10, deficitH));
        const count = isTight ? 1 : Math.max(1, Math.ceil(deficitH / contractH));
        const virtuals = Array.from({ length: count }, (_, i) => ({
          id: `virtual_seasonal_${role}_${i}`, name: `Saisonnier ${roleLabel} ${i + 1}`,
          role, contractHours: contractH,
        }));
        try {
          const result = await runHireScenario(virtuals);
          const impact = computeImpact(result.avgWorkerHours, result.minFills);
          solverRuns++; consecutiveFailures = 0; await emitProgress(`Scénario ${solverRuns}/${SOLVER_BUDGET}…`);
          const profiles = analyzeVirtualAssignments(virtuals.map(v => v.id), result);
          const profileDesc = profiles.length > 0
            ? profiles.map((p, i) => `${profiles.length > 1 ? `#${i + 1} : ` : ""}${describeProfile(p)}`).join(" | ")
            : "aucune affectation";
          const actualHours = profiles.reduce((s, p) => s + p.hours, 0);
          const { neededSlots, idealProfile } = hireSlotsAndProfile(result, virtuals.map(v => v.id));
          const paidWeeklyHours = isTight ? 0 : contractH;
          const labor = hireLaborImpact(result, virtuals.map(v => v.id), paidWeeklyHours);
          const laborDesc = labor.overtimeHoursReducedPerWeek > 0
            ? ` Réduit environ ${labor.overtimeHoursReducedPerWeek}h d'heures sup/semaine. Solde salarial estimé sur ${labor.analysisWeeks} semaines : ${labor.netLaborSavingsCents >= 0 ? "+" : ""}${Math.round(labor.netLaborSavingsCents / 100)}€ (HS évitées ${Math.round(labor.overtimeCostReducedCents / 100)}€ vs coût contrat ${Math.round(labor.newHireCostCents / 100)}€).`
            : "";
          const hireLabel = isTight
            ? `Saisonnier de renfort ${roleLabel} (sans heures garanties)`
            : `Embaucher ${count} saisonnier ${roleLabel}`;
          const hireDesc = isTight
            ? `Recruter 1 saisonnier/CDD pour la ${roleLabel} sans heures minimum — filet de sécurité en cas d'absence ou pic d'activité (marge actuelle : ${Math.round(surplusRatio * 100)}%). Profil : ${profileDesc}.${laborDesc}`
            : `Recruter ${count} saisonnier(s) pour la ${roleLabel} (pas d'heures minimum, ~${Math.round(actualHours)}h utilisées). Profil : ${profileDesc}.${laborDesc}`;
          hireRecommendations.push({
            id: `hire_seasonal_${role}`, type: "hire_seasonal",
            label: hireLabel,
            description: hireDesc,
            role, contractHours: isTight ? 0 : Math.round(actualHours / Math.max(1, count)), neededSlots, idealProfile, ...labor, score: Math.abs(scoreImpact(impact)),
          });
        } catch (e) { if (e instanceof DOMException && e.name === "AbortError") throw e; consecutiveFailures++; }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase 4: OT policy recommendations
  // ═══════════════════════════════════════════════════════════════
  currentPhase = "finalize";
  await emitProgress("Finalisation…");

  // No standalone overtime-policy recommendation here: Comptoir does not know
  // the restaurant's marginal revenue well enough to price covered/missed
  // services. Overtime is only valued inside concrete labor moves, such as
  // removing a worker and absorbing the hours with a 46h temporary cap.

  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      aborted = true;
      console.log("Auto-optimize aborted by client after", solverRuns, "solver runs");
    } else {
      throw e;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Response
  // ═══════════════════════════════════════════════════════════════
  function solverCapacity(role: string) {
    let total = 0;
    for (const wl of workerLoads) {
      if (wl.role === role) total += baseWorkerHours.get(wl.workerId) ?? 0;
    }
    return Math.round(total * 10) / 10;
  }

  function contractSurplus(role: string) {
    const cap = baseResult.capacity.find(c => c.role === role);
    return cap?.surplusHours ?? 0;
  }

  const recommendations = allMoves
    .filter(m => m.displayEligible !== false)
    .map(m => describeHrFeasibility({ ...m.rec, score: scoreRecommendationForDisplay(m.rec) }))
    .sort((a, b) => b.score - a.score);

  const baselineSummary = {
    kitchen: {
      surplus: contractSurplus("kitchen"),
      understaffed: baseUnderstaffed("kitchen"),
      verdict: contractVerdict("kitchen"),
      totalContract: baseResult.capacity.find(c => c.role === "kitchen")?.totalContractHours ?? 0,
      totalCapacity: solverCapacity("kitchen"),
      totalDemand: baseResult.capacity.find(c => c.role === "kitchen")?.totalDemandHours ?? 0,
      otCapacity: baseResult.capacity.find(c => c.role === "kitchen")?.otCapacityHours ?? 0,
    },
    floor: {
      surplus: contractSurplus("floor"),
      understaffed: baseUnderstaffed("floor"),
      verdict: contractVerdict("floor"),
      totalContract: baseResult.capacity.find(c => c.role === "floor")?.totalContractHours ?? 0,
      totalCapacity: solverCapacity("floor"),
      totalDemand: baseResult.capacity.find(c => c.role === "floor")?.totalDemandHours ?? 0,
      otCapacity: baseResult.capacity.find(c => c.role === "floor")?.otCapacityHours ?? 0,
    },
    otMode,
    otWeeklyCap,
    scenariosRun: solverRuns,
  };

  return { recommendations, compounds, hireRecommendations, otPolicyRecommendations, baseline: baselineSummary, profiles: baseResult.profiles, activeProfileId: baseResult.activeProfileId, aborted };
}
