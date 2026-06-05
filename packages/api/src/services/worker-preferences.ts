import { and, eq } from "drizzle-orm";
import { db, rawDb } from "../db/connection.js";
import { users, workerPreferredSchedule, workerRestaurantProfiles } from "../db/schema.js";
import type { AuthUser } from "../middleware/auth.js";
import { logAudit, type AuditSource } from "../db/audit.js";
import { bumpCacheVersion } from "./baseline-cache.js";
import { userHasActiveRestaurantMembership } from "./restaurant-context.js";

export type PreferenceSlotPatch = { matin?: boolean; midi?: boolean; soir?: boolean; closed?: boolean };

export class WorkerPreferenceError extends Error {
  constructor(public status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "WorkerPreferenceError";
  }
}

const DAY_TO_NUM: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

function tableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

function hasDirectPreferenceMembership(user: AuthUser): boolean {
  return userHasActiveRestaurantMembership(user.id, user.activeRestaurantId);
}

function sharedTargetProfile(user: AuthUser) {
  if (!tableExists("worker_restaurant_profiles")) {
    throw new WorkerPreferenceError(403, "Restaurant inaccessible pour ces préférences.");
  }

  const [profile] = db.select({
    contractHours: workerRestaurantProfiles.contractHours,
    maxWeeklyHours: workerRestaurantProfiles.maxWeeklyHours,
  }).from(workerRestaurantProfiles)
    .where(and(
      eq(workerRestaurantProfiles.restaurantId, user.activeRestaurantId),
      eq(workerRestaurantProfiles.userId, user.id),
    ))
    .limit(1).all();

  if (!profile) {
    throw new WorkerPreferenceError(403, "Restaurant inaccessible pour ces préférences.");
  }

  return profile;
}

export function getOwnPreferences(user: AuthUser) {
  const [row] = db.select({
    contractHours: users.contractHours,
    maxWeeklyHours: users.maxWeeklyHours,
    coupureWilling: users.coupureWilling,
  }).from(users)
    .where(eq(users.id, user.id))
    .limit(1).all();
  if (!row) throw new WorkerPreferenceError(404, "Utilisateur introuvable.");

  const preferenceProfile = hasDirectPreferenceMembership(user)
    ? row
    : { ...sharedTargetProfile(user), coupureWilling: row.coupureWilling };

  const slots = db.select({
    dayOfWeek: workerPreferredSchedule.dayOfWeek,
    midi: workerPreferredSchedule.midi,
    soir: workerPreferredSchedule.soir,
  }).from(workerPreferredSchedule)
    .where(and(eq(workerPreferredSchedule.workerId, user.id), eq(workerPreferredSchedule.restaurantId, user.activeRestaurantId)))
    .all();

  return { ...preferenceProfile, slots };
}

export function updateOwnPreferences(user: AuthUser, input: {
  maxWeeklyHours?: number | null;
  coupureWilling?: boolean;
  slotsByDay?: Record<string, PreferenceSlotPatch>;
}, options: { source?: AuditSource } = {}) {
  if (input.maxWeeklyHours !== undefined && input.maxWeeklyHours !== null) {
    if (!Number.isFinite(input.maxWeeklyHours) || input.maxWeeklyHours < 1 || input.maxWeeklyHours > 60) {
      throw new WorkerPreferenceError(400, `Heures max hors limites: ${input.maxWeeklyHours}. Donne un nombre entre 35 et 48.`);
    }
  }

  const slotsByDay = input.slotsByDay ?? {};
  const invalidDay = Object.keys(slotsByDay).find((day) => !DAY_TO_NUM[day]);
  if (invalidDay) throw new WorkerPreferenceError(400, `Jour inconnu : "${invalidDay}".`);

  const hasDirectMembership = hasDirectPreferenceMembership(user);
  if (!hasDirectMembership) sharedTargetProfile(user);

  const userPatch: Record<string, unknown> = {};
  if (input.maxWeeklyHours !== undefined && hasDirectMembership) userPatch.maxWeeklyHours = input.maxWeeklyHours;
  if (input.coupureWilling !== undefined) userPatch.coupureWilling = input.coupureWilling;

  if (Object.keys(userPatch).length > 0) {
    db.update(users).set(userPatch)
      .where(eq(users.id, user.id))
      .run();
  }

  if (input.maxWeeklyHours !== undefined && !hasDirectMembership) {
    db.update(workerRestaurantProfiles)
      .set({ maxWeeklyHours: input.maxWeeklyHours })
      .where(and(
        eq(workerRestaurantProfiles.restaurantId, user.activeRestaurantId),
        eq(workerRestaurantProfiles.userId, user.id),
      ))
      .run();
  }

  for (const [day, patch] of Object.entries(slotsByDay)) {
    const dayNum = DAY_TO_NUM[day];
    const existing = db.select({
      id: workerPreferredSchedule.id,
      midi: workerPreferredSchedule.midi,
      soir: workerPreferredSchedule.soir,
    }).from(workerPreferredSchedule)
      .where(and(
        eq(workerPreferredSchedule.workerId, user.id),
        eq(workerPreferredSchedule.restaurantId, user.activeRestaurantId),
        eq(workerPreferredSchedule.dayOfWeek, dayNum),
      )).limit(1).all()[0];

    let midi = existing?.midi ?? false;
    let soir = existing?.soir ?? false;
    if (patch.closed) {
      midi = false;
      soir = false;
    } else {
      if (patch.matin !== undefined || patch.midi !== undefined) midi = Boolean(patch.matin ?? patch.midi);
      if (patch.soir !== undefined) soir = Boolean(patch.soir);
    }

    if (existing) {
      db.update(workerPreferredSchedule)
        .set({ midi, soir, zones: "{}" })
        .where(eq(workerPreferredSchedule.id, existing.id)).run();
    } else {
      db.insert(workerPreferredSchedule).values({
        workerId: user.id,
        restaurantId: user.activeRestaurantId,
        dayOfWeek: dayNum,
        midi,
        soir,
        zones: "{}",
      }).run();
    }
  }

  if (Object.keys(userPatch).length > 0 || input.maxWeeklyHours !== undefined || Object.keys(slotsByDay).length > 0) {
    logAudit({
      restaurantId: user.activeRestaurantId,
      tableName: hasDirectMembership || input.coupureWilling !== undefined ? "users" : "worker_restaurant_profiles",
      rowId: user.id,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source: options.source ?? "dashboard",
      summary: `Préférences de planning mises à jour${input.maxWeeklyHours !== undefined ? ` (max=${input.maxWeeklyHours ?? "contrat"}h)` : ""}${input.coupureWilling !== undefined ? ` (coupures=${input.coupureWilling ? "oui" : "non"})` : ""}${Object.keys(slotsByDay).length ? ` (${Object.keys(slotsByDay).length} jour(s))` : ""}`,
    });
    bumpCacheVersion(user.activeRestaurantId);
  }

  return getOwnPreferences(user);
}
