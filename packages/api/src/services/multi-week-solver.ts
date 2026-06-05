/**
 * Multi-week ILP solver — builds and solves unified N-week models.
 *
 * Extracted from settings.ts to keep routes thin.
 * This module orchestrates the per-week model building (via autostaffing's _buildOnly)
 * and merges them into a single ILP solve for cross-week constraint enforcement.
 */

import { db } from "../db/connection.js";
import { services } from "../db/schema.js";
import { eq, and, gte, lte, ne } from "drizzle-orm";
import { fmtDateUTC, parseDateUTC, serviceHours as calcServiceHours, isoDayOfWeek } from "../utils/scheduling.js";
import type { MultiWeekConfig, ILPSlot, ILPResult, AvailabilityChecker, SlotFillFloors } from "../utils/ilp-solver.js";
import { solveWithTiers } from "../utils/solver-tiers.js";
import { generatePlan, type PlanOptions } from "../routes/autostaffing.js";
import {
  buildCacheKey,
  getCached,
  loadSolverFingerprint,
  setCached,
} from "./baseline-cache.js";
import {
  buildHintKey,
  getHints,
  setHints,
  slotKey,
  type HintAssignment,
} from "./hint-store.js";
import { addHintEnabledForPreset } from "./addhint-policy.js";
import { deriveDowTemplates, templateMatchEnabled } from "./dow-template.js";
import type { WeightConfig } from "@comptoir/shared";

// ── OT helpers ──

/** Compute per-worker OT cap from restaurant OT policy */
export function otCapForMode(otMode: string, weeklyCap: number): number {
  return otMode === "strict" ? 39 : otMode === "controlled" ? Math.min(weeklyCap, 48) : 48;
}

/** Compute total OT capacity (in hours) for a list of workers given the OT policy */
export function computeOtCapacity(
  workers: Array<{ contractHours: number | null; maxWeeklyHours?: number | null }>,
  otMode: string,
  weeklyCap: number,
): number {
  const cap = otCapForMode(otMode, weeklyCap);
  return workers.reduce((total, w) => {
    const contract = w.contractHours ?? 35;
    const workerCap = w.maxWeeklyHours && w.maxWeeklyHours > 0 ? w.maxWeeklyHours : cap;
    const maxOT = Math.max(0, workerCap - contract);
    return total + maxOT;
  }, 0);
}

// ── Multi-week result extraction ──

export type MultiWeekExtract = {
  avgWorkerHours: Map<string, number>;
  minFills: Map<string, number>;
};

/**
 * Extract averaged worker hours and min slot fills from a multi-week ILP result.
 * Used by both staffing-analysis and auto-optimize to interpret results consistently.
 */
export function extractMultiWeek(
  ilpResult: ILPResult,
  mergedSlots: ILPSlot[],
  existingHoursByWeek: Map<string, number[]>,
  numWeeks: number,
): MultiWeekExtract {
  const avgWorkerHours = new Map<string, number>();
  if (ilpResult.perWeekWorkerHours) {
    for (const [workerId, weeklyHours] of ilpResult.perWeekWorkerHours) {
      const existingPerWeek = existingHoursByWeek.get(workerId) || [];
      const totalPerWeek = weeklyHours.map((h, i) => h + (existingPerWeek[i] ?? 0));
      const avg = totalPerWeek.reduce((a, b) => a + b, 0) / numWeeks;
      avgWorkerHours.set(workerId, Math.round(avg * 100) / 100);
    }
  }

  const slotMap = new Map(mergedSlots.map(s => [s.id, s]));
  const minFills = new Map<string, number>();
  for (let w = 0; w < numWeeks; w++) {
    const weekAssignments = new Map<string, Set<string>>();
    for (const a of ilpResult.assignments) {
      const slot = slotMap.get(a.slotId)!;
      if ((slot.week ?? 0) !== w) continue;
      const key = `${slot.dow}_${slot.role}_${slot.zone}`;
      if (!weekAssignments.has(key)) weekAssignments.set(key, new Set());
      weekAssignments.get(key)!.add(a.workerId);
    }
    const seen = new Set<string>();
    for (const s of mergedSlots) {
      if ((s.week ?? 0) !== w) continue;
      const key = `${s.dow}_${s.role}_${s.zone}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const newFill = weekAssignments.get(key)?.size || 0;
      const fill = s.existingFill + newFill;
      const prev = minFills.get(key);
      minFills.set(key, prev === undefined ? fill : Math.min(prev, fill));
    }
  }

  return { avgWorkerHours, minFills };
}

// ── Multi-week solve orchestration ──

export type MultiWeekSolveResult = {
  ilpResult: ILPResult;
  mergedSlots: ILPSlot[];
  existingHoursByWeek: Map<string, number[]>;
};

// ── Baseline cache (no what-if overrides) ──
// Cached keys include content checksums + a cacheVersion counter, so mutations
// to templates/targets/workers/availability or to restaurant config invalidate
// entries without caller coordination. Logic lives in `baseline-cache.ts`.

/**
 * Non-`profileIdOverride` keys that, when set, mark the solve as a what-if
 * scenario — those must skip the cache since they're per-request and rarely
 * identical between callers.
 */
function hasWhatIfOverrides(planOpts: Omit<PlanOptions, "_buildOnly"> | undefined): boolean {
  if (!planOpts) return false;
  const whatIfKeys: (keyof Omit<PlanOptions, "_buildOnly">)[] = [
    "holidayFilter",
    "extraAbsences",
    "contractOverrides",
    "maxWeeklyOverrides",
    "restrictionOverrides",
    "roleOverrides",
    "subRoleOverrides",
    "virtualWorkers",
    "syntheticServices",
    "targetOverrides",
    "openDaysOverride",
  ];
  return whatIfKeys.some(k => planOpts[k] != null);
}

/**
 * Build and solve a unified N-week ILP model.
 *
 * Baseline solves (no what-if overrides) are cached for 5 minutes. The cache
 * key hashes every input that can change the solve — restaurant config,
 * profile selection, base Monday, week count, weights, and checksums of the
 * mutable tables the solver reads.
 */
export async function runMultiWeekSolve(
  restaurantId: string,
  baseMonday: string,
  numWeeks: number,
  planOpts?: Omit<PlanOptions, "_buildOnly">,
  slotFillFloors?: SlotFillFloors,
  weights?: WeightConfig,
  maxTier: number = 1,
  presetName?: string | null,
): Promise<MultiWeekSolveResult> {
  // Cache check. `profileIdOverride` is part of the key — different profiles
  // get distinct entries. What-if overrides (contract/role/extra-absence, …)
  // bypass the cache entirely because they're per-request.
  const isCacheable = !hasWhatIfOverrides(planOpts) && !slotFillFloors;
  let cacheKey: string | null = null;
  if (isCacheable) {
    const fingerprint = loadSolverFingerprint(restaurantId);
    cacheKey = buildCacheKey({
      restaurantId,
      profileId: planOpts?.profileIdOverride,
      baseMonday,
      numWeeks,
      weights,
      ...fingerprint,
    });
    const cached = getCached<MultiWeekSolveResult>(cacheKey);
    if (cached) return cached;
  }
  // Phase 1: Collect model inputs from each week via _buildOnly
  const weekModelInputs: Array<{
    ilpWorkers: any[];
    ilpSlots: ILPSlot[];
    ilpConfig: any;
    availChecker: any;
    existingHoursByWorker: Map<string, number>;
  }> = [];

  for (let w = 0; w < numWeeks; w++) {
    const weekMon = fmtDateUTC((() => {
      const d = parseDateUTC(baseMonday);
      d.setUTCDate(d.getUTCDate() + w * 7);
      return d;
    })());

    const buildResult = await generatePlan(restaurantId, weekMon, undefined, {
      ...planOpts,
      _buildOnly: true,
    });

    const inputs = (buildResult as any)._modelInputs;
    if (!inputs) throw new Error(`Week ${w}: _buildOnly returned no model inputs`);

    const existingHours = new Map<string, number>();
    for (const wkr of inputs.ilpWorkers) {
      existingHours.set(wkr.id, wkr.existingWeeklyHours);
    }

    weekModelInputs.push({ ...inputs, existingHoursByWorker: existingHours });
  }

  // Phase 2: Merge workers from all weeks (union) to handle contracts starting/ending mid-window
  const seenWorkerIds = new Set<string>();
  const mergedWorkers: any[] = [];
  const workerCheckerSource = new Map<string, number>();
  for (let w = 0; w < numWeeks; w++) {
    for (const wkr of weekModelInputs[w].ilpWorkers) {
      if (!seenWorkerIds.has(wkr.id)) {
        seenWorkerIds.add(wkr.id);
        mergedWorkers.push(wkr);
        workerCheckerSource.set(wkr.id, w);
      }
    }
  }

  const mergedConfig = weekModelInputs[0].ilpConfig;

  // Composite checker: delegates to the checker from the first week where each worker appears
  const mergedChecker: AvailabilityChecker = {
    isAvailable(workerId: string, slot: ILPSlot): boolean {
      const srcWeek = workerCheckerSource.get(workerId);
      if (srcWeek === undefined) return false;
      return weekModelInputs[srcWeek].availChecker.isAvailable(workerId, slot);
    },
    prefersSlot(workerId: string, dow: number, zone: string): boolean {
      const srcWeek = workerCheckerSource.get(workerId);
      if (srcWeek === undefined) return false;
      return weekModelInputs[srcWeek].availChecker.prefersSlot(workerId, dow, zone);
    },
  };

  // Merge slots with global IDs and week indices
  const mergedSlots: ILPSlot[] = [];
  let globalSlotId = 0;

  for (let w = 0; w < numWeeks; w++) {
    const weekSlots = weekModelInputs[w].ilpSlots;
    const weekRemap = new Map<number, number>();
    for (const s of weekSlots) {
      weekRemap.set(s.id, globalSlotId++);
    }
    for (const s of weekSlots) {
      mergedSlots.push({
        ...s,
        id: weekRemap.get(s.id)!,
        week: w,
        compoundPairId: s.compoundPairId !== undefined ? weekRemap.get(s.compoundPairId) : undefined,
      });
    }
  }

  // Phase 3: Build MultiWeekConfig for per-week constraints
  const existingHoursByWeek = new Map<string, number[]>();
  for (const wkr of mergedWorkers) {
    const perWeek: number[] = [];
    for (let w = 0; w < numWeeks; w++) {
      perWeek.push(weekModelInputs[w].existingHoursByWorker.get(wkr.id) ?? 0);
    }
    existingHoursByWeek.set(wkr.id, perWeek);
  }

  // C9: Query historical services to build per-week rolling-average base
  const planStartDate = parseDateUTC(baseMonday);
  const histStartDate = new Date(planStartDate);
  histStartDate.setUTCDate(histStartDate.getUTCDate() - 12 * 7);
  const histEndDate = new Date(planStartDate);
  histEndDate.setUTCDate(histEndDate.getUTCDate() - 1);

  const historicalSvcs = db.select({
    workerId: services.workerId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
  }).from(services)
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, fmtDateUTC(histStartDate)),
      lte(services.date, fmtDateUTC(histEndDate)),
      ne(services.status, "cancelled"),
    )).all();

  const workerHistByWeek = new Map<string, number[]>();
  const planStartMs = planStartDate.getTime();
  for (const s of historicalSvcs) {
    const hrs = calcServiceHours(s.startTime, s.endTime);
    const serviceDateMs = parseDateUTC(s.date).getTime();
    const daysBefore = Math.round((planStartMs - serviceDateMs) / (24 * 3600 * 1000));
    const weekIdx = Math.floor((daysBefore - 1) / 7);
    if (weekIdx < 0 || weekIdx >= 12) continue;
    if (!workerHistByWeek.has(s.workerId)) workerHistByWeek.set(s.workerId, new Array(12).fill(0));
    workerHistByWeek.get(s.workerId)![weekIdx] += hrs;
  }

  const c9BaseHours = new Map<string, number[]>();
  const c9BaseWeeks = new Map<string, number[]>();

  for (const wkr of mergedWorkers) {
    const weekHrs = workerHistByWeek.get(wkr.id) || new Array(12).fill(0);
    const baseHours: number[] = [];
    const baseWeeks: number[] = [];
    for (let wk = 0; wk < numWeeks; wk++) {
      const numHistWeeks = Math.max(0, 11 - wk);
      let total = 0;
      let weeksWithData = 0;
      for (let idx = 0; idx < numHistWeeks; idx++) {
        total += weekHrs[idx];
        if (weekHrs[idx] > 0) weeksWithData++;
      }
      baseHours.push(Math.round(total * 100) / 100);
      baseWeeks.push(weeksWithData);
    }
    c9BaseHours.set(wkr.id, baseHours);
    c9BaseWeeks.set(wkr.id, baseWeeks);
  }

  const multiWeekConfig: MultiWeekConfig = {
    numWeeks,
    existingHoursByWeek,
    c9BaseHours,
    c9BaseWeeks,
  };

  // Phase 4: Solve via CP-SAT (solveWithTiers → solveWithFallback auto-falls
  // back to ILP on CPSATUnreachableError). ILP remains on disk as a safety
  // net inside solver-fallback.ts; the diagnostic SOLVER=ilp opt-out was
  // retired with the Phase 3 cleanup.

  // Warm-start: load last successful assignment list for this (restaurant,
  // baseMonday, numWeeks, preset) key. Preset is part of the key because each
  // preset has a different objective landscape — reusing a hint from a
  // different preset is strictly worse than no hint. Per-preset gate
  // `ADDHINT_DISABLED_PRESETS` additionally skips the load for presets where
  // AddHint measured a >2·SE regression (économique, per the 2026-04-24
  // cross-preset sweep); the write side mirrors the gate so disabled presets
  // don't pollute the store with entries they'll never read.
  const hintKey = buildHintKey(restaurantId, baseMonday, numWeeks, presetName);
  const hintsAllowed = addHintEnabledForPreset(presetName);
  const hints = hintsAllowed ? getHints(hintKey) ?? undefined : undefined;

  // Template-match rollout switch. Default ON since 2026-04-24 — the term
  // fires for équipe-stable preset customers (templateMatch=120 in preset
  // config), no-op for others (templateMatch=0). Set TEMPLATE_MATCH_ENABLED=0
  // to disable as emergency rollback.
  const dowTemplates = templateMatchEnabled()
    ? deriveDowTemplates(restaurantId, baseMonday)
    : undefined;

  const ilpResult = await solveWithTiers(mergedWorkers, mergedSlots, mergedConfig, mergedChecker, multiWeekConfig, slotFillFloors, weights, maxTier, hints, dowTemplates);
  const tag = ilpResult.solverUsed === "ilp-fallback" ? "CP-SAT→ILP" : "CP-SAT";
  const tierStr = ilpResult.solveTier !== undefined && ilpResult.solveTier > 0
    ? ` [tier ${ilpResult.solveTier}: ${(ilpResult.relaxations ?? []).join(",") || "none"}]`
    : "";
  console.log(`[${tag}]${tierStr} ${ilpResult.status} — ${ilpResult.assignments.length} assignments in ${ilpResult.solveTimeMs.toFixed(0)}ms`);

  const solveResult = { ilpResult, mergedSlots, existingHoursByWeek };

  if (cacheKey !== null) setCached(cacheKey, solveResult);

  // Save the assignment list as the next solve's warm-start hint. Only bother
  // when CP-SAT produced a usable result — infeasible/error shouldn't teach
  // the solver anything. Slot ids are transient across rebuilds; stable
  // slotKey tuples survive eligibility drift. `hintsAllowed` gates the write
  // symmetrically with the read above: a disabled preset would otherwise
  // accumulate hints it never consumes (and pollute a sibling preset on the
  // same horizon if the user switches within the TTL).
  if (hintsAllowed && (ilpResult.status === "optimal" || ilpResult.status === "feasible") && ilpResult.assignments.length > 0) {
    const slotById = new Map(mergedSlots.map(s => [s.id, s]));
    const newHints: HintAssignment[] = [];
    for (const a of ilpResult.assignments) {
      const s = slotById.get(a.slotId);
      if (!s) continue;
      newHints.push({ workerId: a.workerId, slotKey: slotKey(s) });
    }
    if (newHints.length > 0) setHints(hintKey, newHints);
  }

  return solveResult;
}
