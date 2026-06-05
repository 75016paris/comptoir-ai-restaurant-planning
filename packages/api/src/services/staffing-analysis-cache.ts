import { desc, eq, inArray } from "drizzle-orm";
import { resolveWeights, parseCustomWeights, type WeightConfig } from "@comptoir/shared";
import { db } from "../db/connection.js";
import { restaurants, staffingAnalysisCache } from "../db/schema.js";
import { fmtDate, getMonday } from "../utils/scheduling.js";
import { buildCacheKey, loadSolverFingerprint } from "./baseline-cache.js";
import { runMultiWeekSolve } from "./multi-week-solver.js";

const LONG_HORIZON_WEEKS = 12;
const runningKeys = new Set<string>();

export type LongHorizonStaffingSummary = {
  status: "running" | "ok" | "error" | "missing";
  horizonWeeks: number;
  baseMonday: string;
  profileId?: string;
  generatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  cacheKey?: string;
  assignments?: number;
  slots?: number;
  uncoveredSlots?: number;
  shortage?: number;
  solveStatus?: string;
  solveTier?: number;
  relaxations?: string[];
  solverUsed?: string;
  solveTimeMs?: number;
  error?: string;
};

export function getLongHorizonBaseMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + 28 - d.getDay() + 1);
  return getMonday(fmtDate(d));
}

function isUsableStatus(status: string): boolean {
  return status === "optimal" || status === "feasible";
}

function buildLongHorizonCacheKey(input: {
  restaurantId: string;
  profileId?: string;
  baseMonday: string;
  weights?: WeightConfig;
}): string {
  return buildCacheKey({
    restaurantId: input.restaurantId,
    profileId: input.profileId,
    baseMonday: input.baseMonday,
    numWeeks: LONG_HORIZON_WEEKS,
    weights: input.weights,
    ...loadSolverFingerprint(input.restaurantId),
  });
}

function summarizeSolve(input: {
  profileId?: string;
  baseMonday: string;
  cacheKey: string;
  startedAt: number;
  solve: Awaited<ReturnType<typeof runMultiWeekSolve>>;
}): LongHorizonStaffingSummary {
  const assignedBySlot = new Map<number, number>();
  for (const a of input.solve.ilpResult.assignments) {
    assignedBySlot.set(a.slotId, (assignedBySlot.get(a.slotId) ?? 0) + 1);
  }

  let uncoveredSlots = 0;
  let shortage = 0;
  for (const s of input.solve.mergedSlots) {
    if (s.compound && s.compoundPairId !== undefined && s.id > s.compoundPairId) continue;
    const target = Math.max(0, s.target - s.existingFill);
    const fill = assignedBySlot.get(s.id) ?? 0;
    const missing = Math.max(0, target - fill);
    if (missing > 0) {
      uncoveredSlots++;
      shortage += missing;
    }
  }

  const now = Date.now();
  return {
    status: "ok",
    horizonWeeks: LONG_HORIZON_WEEKS,
    baseMonday: input.baseMonday,
    profileId: input.profileId,
    generatedAt: new Date(now).toISOString(),
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(now).toISOString(),
    durationMs: now - input.startedAt,
    cacheKey: input.cacheKey,
    assignments: input.solve.ilpResult.assignments.length,
    slots: input.solve.mergedSlots.length,
    uncoveredSlots,
    shortage,
    solveStatus: input.solve.ilpResult.status,
    solveTier: input.solve.ilpResult.solveTier,
    relaxations: input.solve.ilpResult.relaxations,
    solverUsed: input.solve.ilpResult.solverUsed,
    solveTimeMs: input.solve.ilpResult.solveTimeMs,
  };
}

function rowToSummary(row: typeof staffingAnalysisCache.$inferSelect): LongHorizonStaffingSummary {
  if (row.status === "ok" && row.result) {
    try {
      const parsed = JSON.parse(row.result) as LongHorizonStaffingSummary;
      return {
        ...parsed,
        status: "ok",
        startedAt: row.startedAt,
        finishedAt: row.finishedAt ?? parsed.finishedAt,
        durationMs: row.durationMs ?? parsed.durationMs,
        cacheKey: row.cacheKey,
      };
    } catch {
      return {
        status: "error",
        horizonWeeks: row.horizonWeeks,
        baseMonday: row.baseMonday,
        profileId: row.profileId ?? undefined,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt ?? undefined,
        durationMs: row.durationMs ?? undefined,
        cacheKey: row.cacheKey,
        error: "Résultat 12 semaines illisible",
      };
    }
  }

  return {
    status: row.status,
    horizonWeeks: row.horizonWeeks,
    baseMonday: row.baseMonday,
    profileId: row.profileId ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    cacheKey: row.cacheKey,
    error: row.error ?? undefined,
  };
}

export function getLongHorizonStaffingAnalysis(input: {
  restaurantId: string;
  profileId?: string;
  baseMonday?: string;
  weights?: WeightConfig;
}): LongHorizonStaffingSummary {
  const baseMonday = input.baseMonday ?? getLongHorizonBaseMonday();
  const cacheKey = buildLongHorizonCacheKey({ ...input, baseMonday });
  const row = db.select()
    .from(staffingAnalysisCache)
    .where(eq(staffingAnalysisCache.cacheKey, cacheKey))
    .orderBy(desc(staffingAnalysisCache.startedAt))
    .limit(1)
    .get();

  if (row) return rowToSummary(row);
  if (runningKeys.has(cacheKey)) {
    return {
      status: "running",
      horizonWeeks: LONG_HORIZON_WEEKS,
      baseMonday,
      profileId: input.profileId,
      cacheKey,
    };
  }
  return {
    status: "missing",
    horizonWeeks: LONG_HORIZON_WEEKS,
    baseMonday,
    profileId: input.profileId,
    cacheKey,
  };
}

export async function refreshLongHorizonStaffingAnalysis(input: {
  restaurantId: string;
  profileId?: string;
  baseMonday?: string;
  weights?: WeightConfig;
  presetName?: string | null;
}): Promise<LongHorizonStaffingSummary> {
  const baseMonday = input.baseMonday ?? getLongHorizonBaseMonday();
  const cacheKey = buildLongHorizonCacheKey({ ...input, baseMonday });
  if (runningKeys.has(cacheKey)) {
    return getLongHorizonStaffingAnalysis({ ...input, baseMonday });
  }

  runningKeys.add(cacheKey);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  db.insert(staffingAnalysisCache).values({
    restaurantId: input.restaurantId,
    profileId: input.profileId ?? null,
    horizonWeeks: LONG_HORIZON_WEEKS,
    baseMonday,
    cacheKey,
    status: "running",
    startedAt,
    finishedAt: null,
    durationMs: null,
    result: null,
    error: null,
  }).onConflictDoUpdate({
    target: staffingAnalysisCache.cacheKey,
    set: {
      status: "running",
      startedAt,
      finishedAt: null,
      durationMs: null,
      result: null,
      error: null,
    },
  }).run();

  try {
    const solve = await runMultiWeekSolve(
      input.restaurantId,
      baseMonday,
      LONG_HORIZON_WEEKS,
      input.profileId ? { profileIdOverride: input.profileId } : undefined,
      undefined,
      input.weights,
      1,
      input.presetName,
    );

    if (!isUsableStatus(solve.ilpResult.status)) {
      throw new Error(`12-week solver returned ${solve.ilpResult.status}`);
    }

    const summary = summarizeSolve({
      profileId: input.profileId,
      baseMonday,
      cacheKey,
      startedAt: started,
      solve,
    });

    db.update(staffingAnalysisCache).set({
      status: "ok",
      finishedAt: summary.finishedAt,
      durationMs: summary.durationMs,
      result: JSON.stringify(summary),
      error: null,
    }).where(eq(staffingAnalysisCache.cacheKey, cacheKey)).run();

    return summary;
  } catch (e: any) {
    const finishedAt = new Date().toISOString();
    const message = e?.message || String(e);
    db.update(staffingAnalysisCache).set({
      status: "error",
      finishedAt,
      durationMs: Date.now() - started,
      result: null,
      error: message,
    }).where(eq(staffingAnalysisCache.cacheKey, cacheKey)).run();
    return {
      status: "error",
      horizonWeeks: LONG_HORIZON_WEEKS,
      baseMonday,
      profileId: input.profileId,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      cacheKey,
      error: message,
    };
  } finally {
    runningKeys.delete(cacheKey);
  }
}

export function refreshLongHorizonStaffingAnalysisInBackground(input: {
  restaurantId: string;
  profileId?: string;
  baseMonday?: string;
  weights?: WeightConfig;
  presetName?: string | null;
}): void {
  const current = getLongHorizonStaffingAnalysis(input);
  if (current.status === "ok" || current.status === "running") return;
  void refreshLongHorizonStaffingAnalysis(input).catch((e) => {
    console.error("[staffing-analysis-cache] background refresh failed:", e?.message || e);
  });
}

export async function warmLongHorizonStaffingAnalysisCache(): Promise<{
  restaurants: Array<{ restaurantId: string; status: LongHorizonStaffingSummary["status"]; durationMs?: number; error?: string }>;
}> {
  const activeRestaurants = db.select({
    id: restaurants.id,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
  }).from(restaurants)
    .where(inArray(restaurants.status, ["active", "demo"]))
    .all();

  const report: Array<{ restaurantId: string; status: LongHorizonStaffingSummary["status"]; durationMs?: number; error?: string }> = [];
  for (const r of activeRestaurants) {
    const weights = resolveWeights(r.preferredStyle, parseCustomWeights(r.customWeights));
    const summary = await refreshLongHorizonStaffingAnalysis({
      restaurantId: r.id,
      weights,
      presetName: r.preferredStyle,
    });
    report.push({
      restaurantId: r.id,
      status: summary.status,
      durationMs: summary.durationMs,
      error: summary.error,
    });
  }

  return { restaurants: report };
}
