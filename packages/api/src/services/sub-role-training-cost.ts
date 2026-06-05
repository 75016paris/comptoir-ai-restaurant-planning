/**
 * Sub-role training-cost calibration.
 *
 * Auto-optimize Phase 1 scores cross_train / intra_train suggestions with a
 * hardcoded hierarchy-based cost (KITCHEN_HIERARCHY / SALLE_HIERARCHY). That
 * cost reflects a generic "how hard is it to teach X → Y" and doesn't track
 * how those moves actually land per restaurant. This module adds a per-
 * restaurant learning loop:
 *
 *   1. When an admin accepts a suggestion, the frontend records the move via
 *      `recordTrainingMove`. We don't touch the cost yet — outcome first.
 *   2. A nightly cron (`observeTrainingOutcomes`) scans moves from the last
 *      30 days that haven't been observed, classifies success/failure, and
 *      Bayesian-updates the stored `costPoints` for that (fromRole, toRole).
 *   3. Phase 1's cost lookup (`getTrainingCost`) returns the stored value
 *      once a pair has ≥ 5 samples; otherwise the hardcoded default.
 *   4. `adminOverride = true` freezes a row against further updates (UI is a
 *      follow-up).
 *
 * The learned cost is clamped to [0.5×, 2×] of the hardcoded default to
 * prevent runaway (bad early observations can't permanently shift scoring).
 *
 * The hardcoded fallbacks live here, not in optimize-engine.ts, so the
 * lookup and the fallback always agree.
 */

import { and, eq, isNull, gte } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  subRoleTrainingCosts,
  subRoleTrainingMoves,
  services,
  users,
} from "../db/schema.js";

// ── Tunables ──

/** Samples required before the learned cost is used instead of the default. */
export const TRAINING_COST_SAMPLES_THRESHOLD = 5;

/** Lower clamp factor: learned cost can't go below `defaultCost × 0.5`. */
export const TRAINING_COST_CLAMP_MIN_FACTOR = 0.5;

/** Upper clamp factor: learned cost can't exceed `defaultCost × 2.0`. */
export const TRAINING_COST_CLAMP_MAX_FACTOR = 2.0;

/** Services in target role required within the observation window to count as a success. */
export const TRAINING_OUTCOME_MIN_SERVICES = 3;

/** Observation window relative to applied_at (ms). */
export const TRAINING_OBSERVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Is the sub-role training-cost learning loop enabled? Default on; `SUB_ROLE_COST_LEARNING=0` disables. */
export function subRoleCostLearningEnabled(): boolean {
  const raw = process.env.SUB_ROLE_COST_LEARNING;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

// ── Hierarchies + hardcoded fallback costs ──

/**
 * Sub-role hierarchies, high skill → low skill. The index doubles as a
 * difficulty rank for the hardcoded fallback costs.
 */
export const KITCHEN_HIERARCHY: readonly string[] = ["Chef", "Sous-chef", "Cuisinier", "Commis", "Plongeur"];
export const SALLE_HIERARCHY: readonly string[] = ["Maître d'hôtel", "Chef de rang", "Sous-chef de rang", "Serveur", "Runner", "Barman"];

export type Role = "kitchen" | "floor";

function hierarchyFor(role: Role): readonly string[] {
  return role === "kitchen" ? KITCHEN_HIERARCHY : SALLE_HIERARCHY;
}

function rankOf(subRole: string, hierarchy: readonly string[]): number {
  const idx = hierarchy.indexOf(subRole);
  return idx >= 0 ? idx : hierarchy.length;
}

/**
 * Cross-train fallback: switching departments. Harder for high-skilled
 * workers (their current specialisation doesn't transfer) and easier for
 * low-skill roles. Mirrors the old crossTrainCost branching.
 */
export function crossTrainDefaultCost(fromSubRole: string, fromRole: Role): number {
  const rank = rankOf(fromSubRole, hierarchyFor(fromRole));
  if (rank <= 1) return 28; // Chef / Sous-chef / Chef de rang: near-impossible
  if (rank <= 2) return 20; // Cuisinier / Sous-chef de rang: hard
  return 13;                 // Plongeur / Serveur / Runner / Barman: feasible
}

/**
 * Intra-train fallback: within-department re-skilling is asymmetric.
 *
 * The hierarchy is ordered high-skill → entry-level. Moving upward is a
 * promotion/training path; moving downward is a demotion/acceptability problem
 * and should be expensive even when the person already has the technical skill.
 */
export function intraTrainDefaultCost(fromSubRole: string, toSubRole: string, role: Role): number {
  const hierarchy = hierarchyFor(role);
  const fromRank = rankOf(fromSubRole, hierarchy);
  const toRank = rankOf(toSubRole, hierarchy);
  if (fromRank === toRank) return 5;
  const distance = Math.abs(fromRank - toRank);
  if (toRank < fromRank) {
    // Promotion path. Targeting the very top roles (Chef / Maître d'hôtel) is
    // harder than moving from entry-level to a mid-rank role.
    const seniorityPremium = Math.max(0, 2 - toRank) * 6;
    return 6 + distance * 3 + seniorityPremium;
  }
  // Demotion path. Technically easy, socially/contractually hard.
  return 20 + distance * 5;
}

// ── Pure Bayesian helpers ──

/**
 * Bayesian (running-average) update with step size α = 1 / totalSamples.
 * Alpha diminishes as samples accumulate — early observations move the
 * estimate a lot, late ones barely.
 */
export function bayesianUpdate(prior: number, observedCost: number, totalSamples: number): number {
  const n = Math.max(1, totalSamples);
  const alpha = 1 / n;
  return prior * (1 - alpha) + observedCost * alpha;
}

/** Clamp a learned cost to [defaultCost × 0.5, defaultCost × 2.0]. */
export function clampCost(cost: number, defaultCost: number): number {
  const min = defaultCost * TRAINING_COST_CLAMP_MIN_FACTOR;
  const max = defaultCost * TRAINING_COST_CLAMP_MAX_FACTOR;
  if (cost < min) return min;
  if (cost > max) return max;
  return cost;
}

/**
 * Target cost for a positive observation — anchors the running average to
 * the lower clamp so repeated successes pull the cost down.
 */
export function successObservedCost(defaultCost: number): number {
  return defaultCost * TRAINING_COST_CLAMP_MIN_FACTOR;
}

/**
 * Target cost for a negative observation — anchors the running average to
 * the upper clamp so repeated failures pull the cost up.
 */
export function failureObservedCost(defaultCost: number): number {
  return defaultCost * TRAINING_COST_CLAMP_MAX_FACTOR;
}

// ── Shared default-cost lookup ──

/**
 * Return the hardcoded default cost for a given move.
 * For cross_train: fromRole is the worker's best current sub-role, toRole is the target department.
 * For intra_train: both are sub-roles within the target `role` department.
 */
export function defaultTrainingCost(
  moveType: "cross_train" | "intra_train",
  fromRole: string,
  toRole: string,
  role: Role,
): number {
  if (moveType === "cross_train") {
    return crossTrainDefaultCost(fromRole, role);
  }
  return intraTrainDefaultCost(fromRole, toRole, role);
}

// ── DB: lookup + recording + observation ──

/**
 * Return the effective training cost for a (restaurant, fromRole, toRole)
 * tuple. Uses the stored learned cost only once it has ≥ THRESHOLD samples;
 * otherwise returns the hardcoded default.
 *
 * When the learning flag is off, always returns the default.
 */
export function getTrainingCost(
  restaurantId: string,
  fromRole: string,
  toRole: string,
  defaultCost: number,
): number {
  const enabled = subRoleCostLearningEnabled();
  if (!enabled) return defaultCost;
  const [row] = db.select({
    costPoints: subRoleTrainingCosts.costPoints,
    successes: subRoleTrainingCosts.successes,
    failures: subRoleTrainingCosts.failures,
  }).from(subRoleTrainingCosts)
    .where(and(
      eq(subRoleTrainingCosts.restaurantId, restaurantId),
      eq(subRoleTrainingCosts.fromRole, fromRole),
      eq(subRoleTrainingCosts.toRole, toRole),
    ))
    .limit(1).all();
  return resolveTrainingCost(row ?? null, defaultCost, { learningEnabled: enabled });
}

/**
 * Persist that an admin accepted a training suggestion. The row stays
 * unobserved until the nightly cron classifies it.
 */
export function recordTrainingMove(opts: {
  restaurantId: string;
  workerId: string;
  moveType: "cross_train" | "intra_train";
  fromRole: string;
  toRole: string;
  appliedAt?: number;
}): void {
  db.insert(subRoleTrainingMoves).values({
    restaurantId: opts.restaurantId,
    workerId: opts.workerId,
    moveType: opts.moveType,
    fromRole: opts.fromRole,
    toRole: opts.toRole,
    appliedAt: opts.appliedAt ?? Date.now(),
  }).run();
}

/**
 * Classify an applied move as success or failure.
 *
 * cross_train → did the worker fill ≥ MIN_SERVICES in the target department
 *               within the observation window?
 * intra_train → does the worker now carry the target sub-role in their
 *               profile (admin actually added it)?
 *
 * Pure-ish: reads `services` and `users`, no writes.
 */
export function classifyTrainingOutcome(move: {
  restaurantId: string;
  workerId: string;
  moveType: "cross_train" | "intra_train";
  toRole: string;
  appliedAt: number;
  now?: number;
}): "success" | "failure" {
  if (move.moveType === "cross_train") {
    const appliedDate = new Date(move.appliedAt).toISOString().slice(0, 10);
    const count = db.select({ id: services.id }).from(services)
      .where(and(
        eq(services.workerId, move.workerId),
        eq(services.restaurantId, move.restaurantId),
        eq(services.role, move.toRole as Role),
        gte(services.date, appliedDate),
      )).all().length;
    return count >= TRAINING_OUTCOME_MIN_SERVICES ? "success" : "failure";
  }
  // intra_train: target sub-role present on the worker?
  const [u] = db.select({ subRoles: users.subRoles })
    .from(users).where(eq(users.id, move.workerId)).limit(1).all();
  if (!u) return "failure";
  let list: string[] = [];
  try { list = JSON.parse(u.subRoles || "[]"); } catch { list = []; }
  return list.includes(move.toRole) ? "success" : "failure";
}

/**
 * Pure: fold a single outcome into the prior cost row. Returns the next
 * cost row (or `skipped: true` when adminOverride locked it). No IO.
 */
export function computeNextCostRow(opts: {
  prior: { costPoints: number; successes: number; failures: number; adminOverride: boolean } | null;
  outcome: "success" | "failure";
  defaultCost: number;
}): { skipped: boolean; costPoints: number; successes: number; failures: number } {
  if (opts.prior?.adminOverride) {
    return {
      skipped: true,
      costPoints: opts.prior.costPoints,
      successes: opts.prior.successes,
      failures: opts.prior.failures,
    };
  }
  const priorCost = opts.prior?.costPoints ?? opts.defaultCost;
  const successes = (opts.prior?.successes ?? 0) + (opts.outcome === "success" ? 1 : 0);
  const failures = (opts.prior?.failures ?? 0) + (opts.outcome === "failure" ? 1 : 0);
  const observed = opts.outcome === "success"
    ? successObservedCost(opts.defaultCost)
    : failureObservedCost(opts.defaultCost);
  const updated = bayesianUpdate(priorCost, observed, successes + failures);
  const clamped = clampCost(updated, opts.defaultCost);
  return { skipped: false, costPoints: clamped, successes, failures };
}

/**
 * Apply a success/failure to the learned-cost row. Wraps `computeNextCostRow`
 * with a DB upsert. adminOverride rows are left untouched.
 */
export function applyOutcomeToCostRow(opts: {
  restaurantId: string;
  fromRole: string;
  toRole: string;
  outcome: "success" | "failure";
  defaultCost: number;
  now?: number;
}): { updated: boolean; newCost?: number; newSuccesses?: number; newFailures?: number } {
  const now = opts.now ?? Date.now();
  const [existing] = db.select().from(subRoleTrainingCosts)
    .where(and(
      eq(subRoleTrainingCosts.restaurantId, opts.restaurantId),
      eq(subRoleTrainingCosts.fromRole, opts.fromRole),
      eq(subRoleTrainingCosts.toRole, opts.toRole),
    )).limit(1).all();

  const next = computeNextCostRow({
    prior: existing ? {
      costPoints: existing.costPoints,
      successes: existing.successes,
      failures: existing.failures,
      adminOverride: !!existing.adminOverride,
    } : null,
    outcome: opts.outcome,
    defaultCost: opts.defaultCost,
  });

  if (next.skipped) return { updated: false };

  if (existing) {
    db.update(subRoleTrainingCosts)
      .set({ costPoints: next.costPoints, successes: next.successes, failures: next.failures, lastUpdated: now })
      .where(and(
        eq(subRoleTrainingCosts.restaurantId, opts.restaurantId),
        eq(subRoleTrainingCosts.fromRole, opts.fromRole),
        eq(subRoleTrainingCosts.toRole, opts.toRole),
      ))
      .run();
  } else {
    db.insert(subRoleTrainingCosts).values({
      restaurantId: opts.restaurantId,
      fromRole: opts.fromRole,
      toRole: opts.toRole,
      costPoints: next.costPoints,
      successes: next.successes,
      failures: next.failures,
      lastUpdated: now,
      adminOverride: false,
    }).run();
  }

  return { updated: true, newCost: next.costPoints, newSuccesses: next.successes, newFailures: next.failures };
}

/**
 * Pure: decide whether a lookup should return the learned cost or the
 * hardcoded default. Mirrors `getTrainingCost` without the DB read.
 */
export function resolveTrainingCost(
  learned: { costPoints: number; successes: number; failures: number } | null,
  defaultCost: number,
  options?: { learningEnabled?: boolean },
): number {
  const enabled = options?.learningEnabled ?? true;
  if (!enabled) return defaultCost;
  if (!learned) return defaultCost;
  if (learned.successes + learned.failures < TRAINING_COST_SAMPLES_THRESHOLD) return defaultCost;
  return learned.costPoints;
}

/**
 * Nightly cron entry point. Scan unobserved moves from the last 30 days,
 * classify each, write the outcome back to the move row and fold it into
 * the cost row.
 *
 * `role` is carried on the move via `fromRole/toRole` alone — for
 * cross_train, `toRole` is the department name (kitchen/salle); for
 * intra_train, the move happens inside one department, which we pass via
 * the `role` resolver so the correct hierarchy's default cost applies.
 */
export function observeTrainingOutcomes(opts: {
  restaurantId?: string;
  now?: number;
}): { processed: number; successes: number; failures: number } {
  const now = opts.now ?? Date.now();
  const cutoff = now - TRAINING_OBSERVATION_WINDOW_MS;

  const whereClause = opts.restaurantId
    ? and(
        isNull(subRoleTrainingMoves.observedAt),
        gte(subRoleTrainingMoves.appliedAt, cutoff),
        eq(subRoleTrainingMoves.restaurantId, opts.restaurantId),
      )
    : and(
        isNull(subRoleTrainingMoves.observedAt),
        gte(subRoleTrainingMoves.appliedAt, cutoff),
      );

  const moves = db.select().from(subRoleTrainingMoves).where(whereClause).all();

  let processed = 0;
  let successes = 0;
  let failures = 0;

  for (const m of moves) {
    const outcome = classifyTrainingOutcome({
      restaurantId: m.restaurantId,
      workerId: m.workerId,
      moveType: m.moveType as "cross_train" | "intra_train",
      toRole: m.toRole,
      appliedAt: m.appliedAt,
      now,
    });

    // Resolve which hierarchy owns this move so the default cost lines up.
    // cross_train: target department is the toRole. intra_train: the move
    // stays inside one department; we infer it from whichever hierarchy
    // contains both fromRole and toRole (fallback: kitchen).
    const role: Role = m.moveType === "cross_train"
      ? (m.toRole as Role)
      : (KITCHEN_HIERARCHY.includes(m.fromRole as typeof KITCHEN_HIERARCHY[number])
         || KITCHEN_HIERARCHY.includes(m.toRole as typeof KITCHEN_HIERARCHY[number])
          ? "kitchen" : "floor");

    const def = defaultTrainingCost(m.moveType as "cross_train" | "intra_train", m.fromRole, m.toRole, role);

    applyOutcomeToCostRow({
      restaurantId: m.restaurantId,
      fromRole: m.fromRole,
      toRole: m.toRole,
      outcome,
      defaultCost: def,
      now,
    });

    db.update(subRoleTrainingMoves)
      .set({ observedAt: now, outcome })
      .where(eq(subRoleTrainingMoves.id, m.id))
      .run();

    processed++;
    if (outcome === "success") successes++;
    else failures++;
  }

  return { processed, successes, failures };
}
