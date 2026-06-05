/**
 * Open shifts — admin posts a vacant slot, eligible workers claim first-come via WhatsApp.
 *
 * Lifecycle: open → claimed (success) | cancelled | expired.
 * Eligibility reuses rankReplacementCandidates to apply the same OT-cap / no-double-booking /
 * sub-role / rest-period filters that the replacement broker uses.
 *
 * Claim is CAS-based: UPDATE ... WHERE status='open' AND id=:id; if rowCount === 0 someone
 * else got there first. On successful claim, a `services` row is materialised with the
 * winning worker, and the admin is notified.
 */
import { db } from "../db/connection.js";
import { openShifts, services, users, restaurants } from "../db/schema.js";
import { and, desc, eq, ne } from "drizzle-orm";
import { rankReplacementCandidates } from "./replacement-candidates.js";
import { zonedDateTimeToUtc } from "@comptoir/shared";
import { isWeekLocked } from "../utils/week-lock.js";
import { bumpCacheVersion } from "./baseline-cache.js";

export interface CreateOpenShiftInput {
  restaurantId: string;
  createdBy: string;          // admin id
  date: string;               // YYYY-MM-DD
  startTime: string;          // HH:MM
  endTime: string;            // HH:MM
  role: "kitchen" | "floor";
  requiredSubRoles?: string[];
  message?: string | null;
}

export interface OpenShiftCreated {
  id: string;
  candidateIds: string[];
}

export function createOpenShift(input: CreateOpenShiftInput): OpenShiftCreated {
  const ranked = rankReplacementCandidates({
    restaurantId: input.restaurantId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    role: input.role,
    requiredSubRoles: input.requiredSubRoles,
  });

  const candidateIds = ranked.map((r) => r.workerId);
  const expiresAt = `${input.date}T${input.startTime}:00`;

  const [row] = db
    .insert(openShifts)
    .values({
      restaurantId: input.restaurantId,
      createdBy: input.createdBy,
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      role: input.role,
      requiredSubRoles: input.requiredSubRoles ?? [],
      message: input.message ?? null,
      candidateIds,
      expiresAt,
    })
    .returning()
    .all();

  // Caller is responsible for broadcasting (we don't import notify helpers here so
  // the bot can pull this module without dragging notification deps into its typecheck graph).
  return { id: row.id, candidateIds };
}

export type ClaimResult =
  | { ok: true; serviceId: string; restaurantId: string; adminId: string; workerName: string; date: string; startTime: string; endTime: string }
  | { ok: false; reason: "not_eligible" | "already_claimed" | "not_found" | "cancelled" | "locked" };

/**
 * Atomic claim. Caller is the worker (typically via the WhatsApp claim_open_shift tool).
 * Returns ok:true only if this worker was the first to claim. Caller is responsible
 * for notifying the admin using the returned identifiers.
 */
export function claimOpenShift(openShiftId: string, workerId: string): ClaimResult {
  const [shift] = db.select().from(openShifts).where(eq(openShifts.id, openShiftId)).limit(1).all();
  if (!shift) return { ok: false, reason: "not_found" };
  if (shift.status === "claimed") return { ok: false, reason: "already_claimed" };
  if (shift.status === "cancelled" || shift.status === "expired") return { ok: false, reason: "cancelled" };
  if (isWeekLocked(shift.restaurantId, shift.date)) return { ok: false, reason: "locked" };

  const [restaurant] = db.select({ timezone: restaurants.timezone }).from(restaurants).where(eq(restaurants.id, shift.restaurantId)).limit(1).all();
  const expiresAt = zonedDateTimeToUtc(shift.date, shift.startTime, restaurant?.timezone ?? "Europe/Paris");
  if (Date.now() > expiresAt.getTime()) {
    db.update(openShifts).set({ status: "expired" }).where(eq(openShifts.id, openShiftId)).run();
    return { ok: false, reason: "cancelled" };
  }

  const originallyEligible = Array.isArray(shift.candidateIds) ? shift.candidateIds : [];
  const rejectedCandidateIds = Array.isArray(shift.rejectedCandidateIds) ? shift.rejectedCandidateIds : [];
  if (!originallyEligible.includes(workerId)) return { ok: false, reason: "not_eligible" };
  if (rejectedCandidateIds.includes(workerId)) return { ok: false, reason: "not_eligible" };

  const freshEligible = rankReplacementCandidates({
    restaurantId: shift.restaurantId,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    role: shift.role as "kitchen" | "floor",
    requiredSubRoles: Array.isArray(shift.requiredSubRoles) ? shift.requiredSubRoles : [],
  }).some((c) => c.workerId === workerId);
  if (!freshEligible) return { ok: false, reason: "not_eligible" };

  // CAS: only succeeds if status is still 'open'. .returning() lets us detect a no-op update.
  const now = new Date().toISOString();
  const updated = db
    .update(openShifts)
    .set({ status: "claimed", claimedBy: workerId, claimedAt: now })
    .where(and(eq(openShifts.id, openShiftId), eq(openShifts.status, "open")))
    .returning({ id: openShifts.id })
    .all();

  if (updated.length !== 1) return { ok: false, reason: "already_claimed" };

  // Materialise the actual schedule entry now that we have a winner.
  const [svc] = db
    .insert(services)
    .values({
      workerId,
      restaurantId: shift.restaurantId,
      date: shift.date,
      startTime: shift.startTime,
      endTime: shift.endTime,
      role: shift.role,
      status: "scheduled",
      source: "manual",
    })
    .returning()
    .all();

  db.update(openShifts).set({ serviceId: svc.id }).where(eq(openShifts.id, openShiftId)).run();
  db.update(openShifts)
    .set({ status: "cancelled" })
    .where(and(
      eq(openShifts.restaurantId, shift.restaurantId),
      eq(openShifts.date, shift.date),
      eq(openShifts.startTime, shift.startTime),
      eq(openShifts.endTime, shift.endTime),
      eq(openShifts.role, shift.role),
      eq(openShifts.status, "open"),
      ne(openShifts.id, openShiftId),
    ))
    .run();
  bumpCacheVersion(shift.restaurantId);

  const [worker] = db.select({ name: users.name }).from(users).where(eq(users.id, workerId)).limit(1).all();

  return {
    ok: true,
    serviceId: svc.id,
    restaurantId: shift.restaurantId,
    adminId: shift.createdBy,
    workerName: worker?.name ?? "?",
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
  };
}

/** Find the most recent open shift this worker is still eligible for and hasn't already declined. */
export function findClaimableForWorker(restaurantId: string, workerId: string) {
  const rows = db.select().from(openShifts)
    .where(and(eq(openShifts.restaurantId, restaurantId), eq(openShifts.status, "open")))
    .orderBy(desc(openShifts.createdAt), desc(openShifts.id))
    .all();
  return rows.find((r) => {
    const cids = Array.isArray(r.candidateIds) ? r.candidateIds : [];
    const rejected = Array.isArray(r.rejectedCandidateIds) ? r.rejectedCandidateIds : [];
    if (!cids.includes(workerId) || rejected.includes(workerId)) return false;
    if (isWeekLocked(r.restaurantId, r.date)) return false;
    const [restaurant] = db.select({ timezone: restaurants.timezone }).from(restaurants).where(eq(restaurants.id, r.restaurantId)).limit(1).all();
    const expiresAt = zonedDateTimeToUtc(r.date, r.startTime, restaurant?.timezone ?? "Europe/Paris");
    if (Date.now() > expiresAt.getTime()) return false;
    return rankReplacementCandidates({
      restaurantId: r.restaurantId,
      date: r.date,
      startTime: r.startTime,
      endTime: r.endTime,
      role: r.role as "kitchen" | "floor",
      requiredSubRoles: Array.isArray(r.requiredSubRoles) ? r.requiredSubRoles : [],
    }).some((c) => c.workerId === workerId);
  }) ?? null;
}
