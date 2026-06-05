/**
 * Warm-start hint store for CP-SAT solves.
 *
 * Keeps the last successful assignment list per (restaurantId, baseMonday,
 * numWeeks, preset, solver-env) tuple. The next solve over the same key loads
 * these as CP-SAT `add_hint` calls, so the solver tries the previous solution
 * first. Preset is part of the key because different presets have different
 * objective landscapes and reusing a cross-preset hint is strictly worse than
 * no hint.
 *
 * Slots are identified by a stable key built from their schedule tuple, not
 * by the transient numeric id — slot ids are regenerated on each model build
 * and would drift even when the underlying schedule is unchanged.
 *
 * Small LRU (20 entries) with a 5-minute TTL. In-memory only; dies on
 * restart. Same cadence as the baseline cache so hints outlive the cached
 * result's TTL only rarely.
 */
import type { ILPSlot } from "../utils/ilp-solver.js";

export const HINT_TTL_MS = 5 * 60 * 1000;
export const HINT_CAP = 20;

export type HintAssignment = { workerId: string; slotKey: string };

type HintEntry = {
  hints: HintAssignment[];
  ts: number;
  lastAccess: number;
};

const store = new Map<string, HintEntry>();

/** Stable per-slot identifier that survives rebuilds of the multi-week model. */
export function slotKey(s: ILPSlot): string {
  return `${s.week ?? 0}|${s.date}|${s.dow}|${s.role}|${s.zone}|${s.startTime}|${s.endTime}`;
}

const SOLVER_ENV_KEYS = ["SOLVER", "SOLVER_MAX_TIER", "CPSAT_NUM_WORKERS", "CPSAT_RANDOM_SEED"] as const;

function solverEnvFingerprint(): string {
  return SOLVER_ENV_KEYS.map(k => `${k}=${process.env[k] ?? ""}`).join(";");
}

export function buildHintKey(
  restaurantId: string,
  baseMonday: string,
  numWeeks: number,
  presetName: string | null | undefined,
): string {
  // Preset is part of the key because each preset has a different objective
  // landscape — a hint saved under `equipe-stable` is actively misleading for
  // a subsequent `flexibilite` solve on the same horizon.
  return `${restaurantId}|${baseMonday}|${numWeeks}|${presetName ?? ""}|${solverEnvFingerprint()}`;
}

function evictOldestAccessed() {
  let oldestKey: string | null = null;
  let oldestAccess = Infinity;
  for (const [k, v] of store) {
    if (v.lastAccess < oldestAccess) {
      oldestAccess = v.lastAccess;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) store.delete(oldestKey);
}

export function getHints(key: string): HintAssignment[] | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > HINT_TTL_MS) {
    store.delete(key);
    return null;
  }
  hit.lastAccess = Date.now();
  return hit.hints;
}

export function setHints(key: string, hints: HintAssignment[]): void {
  const now = Date.now();
  store.set(key, { hints, ts: now, lastAccess: now });
  while (store.size > HINT_CAP) evictOldestAccessed();
}

/** Test-only: flush the store. */
export function __resetHintStore(): void {
  store.clear();
}
