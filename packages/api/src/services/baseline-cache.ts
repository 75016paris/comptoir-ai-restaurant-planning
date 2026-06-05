/**
 * Baseline multi-week solver cache.
 *
 * Keyed on a SHA-256 of every input that can change the solve: restaurant
 * config, profile selection, base Monday, week count, weights, plus checksums
 * of the mutable DB tables the solver reads (templates, targets, workers and
 * their availability/restrictions). A `cacheVersion` counter on `restaurants`
 * is folded in as a belt-and-suspenders guard — mutation routes bump it to
 * invalidate any stragglers the checksums miss.
 *
 * Small LRU (20 entries) with a 5-minute TTL. In-memory only; dies on
 * restart.
 */
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, rawDb } from "../db/connection.js";
import {
  restaurants,
  serviceTemplates,
  serviceTemplateOverrides,
  staffingTargets,
  staffingProfiles,
  staffingSchedule,
  users,
  workerAvailability,
  workerRestrictions,
  workerPreferredSchedule,
} from "../db/schema.js";
import type { WeightConfig } from "@comptoir/shared";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const CACHE_CAP = 20;

export type CacheKeyInputs = {
  restaurantId: string;
  profileId?: string;
  baseMonday: string;
  numWeeks: number;
  weights?: WeightConfig;
  /** Solver-relevant columns from `restaurants` */
  restaurantFingerprint: string;
  cacheVersion: number;
  templatesChecksum: string;
  targetsChecksum: string;
  workersChecksum: string;
};

type CacheEntry<T> = {
  result: T;
  ts: number;
  lastAccess: number;
  hits: number;
  sizeBytesApprox: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function tableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

/** Stable JSON — sorts object keys so `{a,b}` and `{b,a}` hash the same. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify((v as any)[k])).join(",") + "}";
}

/** Env vars that change the solve behavior — folded into the cache key so
 *  flipping backends or determinism knobs invalidates stale entries. */
const SOLVER_ENV_KEYS = ["SOLVER", "SOLVER_MAX_TIER", "CPSAT_NUM_WORKERS", "CPSAT_RANDOM_SEED"] as const;

function solverEnvFingerprint(): string {
  return SOLVER_ENV_KEYS.map(k => `${k}=${process.env[k] ?? ""}`).join(";");
}

export function buildCacheKey(input: CacheKeyInputs): string {
  const payload = [
    input.restaurantId,
    input.profileId ?? "",
    input.baseMonday,
    String(input.numWeeks),
    input.templatesChecksum,
    input.targetsChecksum,
    input.workersChecksum,
    input.restaurantFingerprint,
    String(input.cacheVersion),
    input.weights ? stableStringify(input.weights) : "",
    solverEnvFingerprint(),
  ].join("|");
  return sha256Hex(payload);
}

/** Query DB and produce the three per-restaurant content checksums + fingerprint + version. */
export function loadSolverFingerprint(restaurantId: string): {
  restaurantFingerprint: string;
  cacheVersion: number;
  templatesChecksum: string;
  targetsChecksum: string;
  workersChecksum: string;
} {
  const [resto] = db.select({
    openDays: restaurants.openDays,
    disabledComplianceRules: restaurants.disabledComplianceRules,
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
    overtimeDistribution: restaurants.overtimeDistribution,
    kitchenSubRoles: restaurants.kitchenSubRoles,
    floorSubRoles: restaurants.floorSubRoles,
    preferredStyle: restaurants.preferredStyle,
    customWeights: restaurants.customWeights,
    workerPreferencesEnabled: restaurants.workerPreferencesEnabled,
    hcrGrid: restaurants.hcrGrid,
    subroleHcrMap: restaurants.subroleHcrMap,
    cacheVersion: restaurants.cacheVersion,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();

  if (!resto) {
    return {
      restaurantFingerprint: "missing",
      cacheVersion: 0,
      templatesChecksum: "missing",
      targetsChecksum: "missing",
      workersChecksum: "missing",
    };
  }

  const { cacheVersion, ...fingerprintCols } = resto;
  const restaurantFingerprint = sha256Hex(stableStringify(fingerprintCols));

  // Templates + per-day overrides
  const templateRows = db.select({
    id: serviceTemplates.id,
    profileId: serviceTemplates.profileId,
    role: serviceTemplates.role,
    zone: serviceTemplates.zone,
    startTime: serviceTemplates.startTime,
    endTime: serviceTemplates.endTime,
    sortOrder: serviceTemplates.sortOrder,
  }).from(serviceTemplates)
    .where(eq(serviceTemplates.restaurantId, restaurantId))
    .orderBy(serviceTemplates.id).all();

  const overrideRows = db.select({
    id: serviceTemplateOverrides.id,
    templateId: serviceTemplateOverrides.templateId,
    dayOfWeek: serviceTemplateOverrides.dayOfWeek,
    startTime: serviceTemplateOverrides.startTime,
    endTime: serviceTemplateOverrides.endTime,
  }).from(serviceTemplateOverrides)
    .innerJoin(serviceTemplates, eq(serviceTemplateOverrides.templateId, serviceTemplates.id))
    .where(eq(serviceTemplates.restaurantId, restaurantId))
    .orderBy(serviceTemplateOverrides.id).all();

  const templatesChecksum = sha256Hex(stableStringify({ t: templateRows, o: overrideRows }));

  // Targets + profile config + weekly schedule
  const targetRows = db.select({
    id: staffingTargets.id,
    profileId: staffingTargets.profileId,
    dayOfWeek: staffingTargets.dayOfWeek,
    role: staffingTargets.role,
    zone: staffingTargets.zone,
    count: staffingTargets.count,
    roleBreakdown: staffingTargets.roleBreakdown,
  }).from(staffingTargets)
    .where(eq(staffingTargets.restaurantId, restaurantId))
    .orderBy(staffingTargets.id).all();

  const profileRows = db.select({
    id: staffingProfiles.id,
    name: staffingProfiles.name,
    sortOrder: staffingProfiles.sortOrder,
    dayPriorities: staffingProfiles.dayPriorities,
  }).from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurantId))
    .orderBy(staffingProfiles.id).all();

  const scheduleRows = db.select({
    id: staffingSchedule.id,
    profileId: staffingSchedule.profileId,
    year: staffingSchedule.year,
    week: staffingSchedule.week,
  }).from(staffingSchedule)
    .where(eq(staffingSchedule.restaurantId, restaurantId))
    .orderBy(staffingSchedule.id).all();

  const targetsChecksum = sha256Hex(stableStringify({ t: targetRows, p: profileRows, s: scheduleRows }));

  // Workers — just the columns that influence scheduling
  const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["kitchen", "floor"], includeInactiveUsers: true });
  const workerRows = workerIds.length > 0 ? db.select({
    id: users.id,
    role: users.role,
    priority: users.priority,
    subRole: users.subRole,
    subRoles: users.subRoles,
    contractHours: users.contractHours,
    maxWeeklyHours: users.maxWeeklyHours,
    adminOtOverride: users.adminOtOverride,
    contractEndDate: users.contractEndDate,
    hcrLevel: users.hcrLevel,
    overtimeWilling: users.overtimeWilling,
    coupureWilling: users.coupureWilling,
    multiRestaurantWilling: users.multiRestaurantWilling,
    startDate: users.startDate,
    active: users.active,
    inactiveFrom: users.inactiveFrom,
    inactiveUntil: users.inactiveUntil,
  }).from(users)
    .where(inArray(users.id, workerIds))
    .orderBy(users.id).all() : [];

  const availabilityRows = db.select({
    id: workerAvailability.id,
    workerId: workerAvailability.workerId,
    dayOfWeek: workerAvailability.dayOfWeek,
    midi: workerAvailability.midi,
    soir: workerAvailability.soir,
    midiStart: workerAvailability.midiStart,
    midiEnd: workerAvailability.midiEnd,
    soirStart: workerAvailability.soirStart,
    soirEnd: workerAvailability.soirEnd,
    continuous: workerAvailability.continuous,
    zones: workerAvailability.zones,
  }).from(workerAvailability)
    .where(eq(workerAvailability.restaurantId, restaurantId))
    .orderBy(workerAvailability.id).all();

  const restrictionRows = db.select({
    id: workerRestrictions.id,
    workerId: workerRestrictions.workerId,
    dayOfWeek: workerRestrictions.dayOfWeek,
    startTime: workerRestrictions.startTime,
    endTime: workerRestrictions.endTime,
    effectiveFrom: workerRestrictions.effectiveFrom,
    effectiveUntil: workerRestrictions.effectiveUntil,
  }).from(workerRestrictions)
    .where(eq(workerRestrictions.restaurantId, restaurantId))
    .orderBy(workerRestrictions.id).all();

  const preferredRows = db.select({
    id: workerPreferredSchedule.id,
    workerId: workerPreferredSchedule.workerId,
    dayOfWeek: workerPreferredSchedule.dayOfWeek,
    midi: workerPreferredSchedule.midi,
    soir: workerPreferredSchedule.soir,
  }).from(workerPreferredSchedule)
    .where(eq(workerPreferredSchedule.restaurantId, restaurantId))
    .orderBy(workerPreferredSchedule.id).all();

  const sharedWorkerRows = tableExists("worker_share_authorizations")
    && tableExists("worker_restaurant_profiles")
    && tableExists("restaurant_memberships")
    && tableExists("owner_memberships")
    ? rawDb.query(`
      SELECT
        wsa.id,
        wsa.owner_id AS ownerId,
        wsa.source_restaurant_id AS sourceRestaurantId,
        wsa.target_restaurant_id AS targetRestaurantId,
        wsa.user_id AS userId,
        wsa.role,
        wsa.status,
        wsa.worker_consented_at AS workerConsentedAt,
        wsa.revoked_at AS revokedAt,
        u.active,
        u.overtime_willing AS overtimeWilling,
        u.start_date AS startDate,
        u.inactive_from AS inactiveFrom,
        u.inactive_until AS inactiveUntil,
        target_profile.priority,
        target_profile.sub_roles AS subRoles,
        target_profile.contract_type AS contractType,
        target_profile.contract_hours AS contractHours,
        target_profile.contract_end_date AS contractEndDate,
        target_profile.max_weekly_hours AS maxWeeklyHours,
        target_profile.admin_ot_override AS adminOtOverride,
        target_profile.hcr_level AS hcrLevel,
        target_profile.hourly_rate AS hourlyRate,
        u.multi_restaurant_willing AS multiRestaurantWilling
      FROM worker_share_authorizations wsa
      INNER JOIN restaurants target_restaurant
        ON target_restaurant.id = wsa.target_restaurant_id
        AND target_restaurant.owner_id = wsa.owner_id
      INNER JOIN restaurants source_restaurant
        ON source_restaurant.id = wsa.source_restaurant_id
        AND source_restaurant.owner_id = wsa.owner_id
      INNER JOIN users u ON u.id = wsa.user_id
      INNER JOIN owner_memberships om
        ON om.owner_id = wsa.owner_id
        AND om.user_id = wsa.user_id
      INNER JOIN restaurant_memberships source_membership
        ON source_membership.restaurant_id = wsa.source_restaurant_id
        AND source_membership.user_id = wsa.user_id
        AND source_membership.role = wsa.role
        AND source_membership.active = 1
      INNER JOIN worker_restaurant_profiles target_profile
        ON target_profile.restaurant_id = wsa.target_restaurant_id
        AND target_profile.user_id = wsa.user_id
      WHERE wsa.target_restaurant_id = ?
        AND wsa.status = 'accepted'
        AND wsa.worker_consented_at IS NOT NULL
        AND wsa.revoked_at IS NULL
        AND u.active = 1
        AND NOT EXISTS (
          SELECT 1
          FROM restaurant_memberships local_membership
          WHERE local_membership.restaurant_id = wsa.target_restaurant_id
            AND local_membership.user_id = wsa.user_id
            AND local_membership.active = 1
        )
      ORDER BY wsa.id
    `).all(restaurantId)
    : [];

  const workersChecksum = sha256Hex(stableStringify({ w: workerRows, sw: sharedWorkerRows, a: availabilityRows, r: restrictionRows, p: preferredRows }));

  return {
    restaurantFingerprint,
    cacheVersion: cacheVersion ?? 0,
    templatesChecksum,
    targetsChecksum,
    workersChecksum,
  };
}

/** LRU eviction — drop the entry with the oldest `lastAccess`. */
function evictOldestAccessed() {
  let oldestKey: string | null = null;
  let oldestAccess = Infinity;
  for (const [k, v] of cache) {
    if (v.lastAccess < oldestAccess) {
      oldestAccess = v.lastAccess;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) cache.delete(oldestKey);
}

function approxSize(v: unknown): number {
  try { return JSON.stringify(v).length; } catch { return 0; }
}

export function getCached<T>(key: string): T | null {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  hit.lastAccess = Date.now();
  hit.hits += 1;
  return hit.result;
}

export function setCached<T>(key: string, result: T): void {
  const now = Date.now();
  cache.set(key, {
    result,
    ts: now,
    lastAccess: now,
    hits: 0,
    sizeBytesApprox: approxSize(result),
  });
  while (cache.size > CACHE_CAP) evictOldestAccessed();
}

/** Bump the per-restaurant cacheVersion counter — called by mutation routes. */
export function bumpCacheVersion(restaurantId: string): void {
  db.update(restaurants)
    .set({ cacheVersion: sql`${restaurants.cacheVersion} + 1` })
    .where(eq(restaurants.id, restaurantId))
    .run();
}

export type CacheSnapshotEntry = {
  key: string;
  ageMs: number;
  hits: number;
  sizeBytesApprox: number;
};

export function getCacheSnapshot(): CacheSnapshotEntry[] {
  const now = Date.now();
  return [...cache.entries()].map(([key, v]) => ({
    key,
    ageMs: now - v.ts,
    hits: v.hits,
    sizeBytesApprox: v.sizeBytesApprox,
  }));
}

/** Test-only: flush the cache. */
export function __resetBaselineCache(): void {
  cache.clear();
}
