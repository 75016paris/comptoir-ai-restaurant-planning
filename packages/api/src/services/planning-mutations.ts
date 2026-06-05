import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { can } from "@comptoir/shared";
import { logAudit, type AuditSource } from "../db/audit.js";
import { db } from "../db/connection.js";
import { publishedWeeks, replacementRequests, services, timeClocks, users } from "../db/schema.js";
import type { AuthUser } from "../middleware/auth.js";
import { bumpCacheVersion } from "./baseline-cache.js";
import { isWeekPublished, notifyScheduleChange, notifyWorkersWeekPublished } from "./notifications.js";
import { getMonday } from "../utils/scheduling.js";
import { isWeekLocked, WEEK_LOCKED_ERROR } from "../utils/week-lock.js";
import { listOwnerRestaurantIdsForRestaurant, userCanBeScheduledInRestaurant } from "./restaurant-context.js";

export class PlanningMutationError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 423,
    message: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlanningMutationError";
  }
}

type PlanningMutationOptions = {
  source?: AuditSource;
  notifyWorkers?: boolean;
  force?: boolean;
};

function requirePermission(user: AuthUser, permission: "PLANNING_EDIT" | "PUBLISH_WEEK") {
  if (!can(user, permission)) {
    throw new PlanningMutationError(403, `Forbidden — missing permission: ${permission}`);
  }
}

function serviceHours(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}

function offsetDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function minutesFromBase(serviceDate: string, baseDate: string, time: string): number {
  const days = Math.round((new Date(`${serviceDate}T12:00:00`).getTime() - new Date(`${baseDate}T12:00:00`).getTime()) / 86_400_000);
  const [h, m] = time.split(":").map(Number);
  return days * 1440 + h * 60 + m;
}

function datedTimesOverlap(aDate: string, aStart: string, aEnd: string, bDate: string, bStart: string, bEnd: string): boolean {
  const as = minutesFromBase(aDate, bDate, aStart);
  let ae = minutesFromBase(aDate, bDate, aEnd);
  const bs = minutesFromBase(bDate, bDate, bStart);
  let be = minutesFromBase(bDate, bDate, bEnd);
  if (ae <= as) ae += 1440;
  if (be <= bs) be += 1440;
  return as < be && bs < ae;
}

function findOverlap(workerId: string, restaurantIds: string[], date: string, startTime: string, endTime: string) {
  const rows = db.select({ id: services.id, startTime: services.startTime, endTime: services.endTime, date: services.date })
    .from(services)
    .where(and(
      eq(services.workerId, workerId),
      restaurantIds.length > 1 ? inArray(services.restaurantId, restaurantIds) : eq(services.restaurantId, restaurantIds[0]),
      inArray(services.date, [offsetDate(date, -1), date, offsetDate(date, 1)]),
      ne(services.status, "cancelled"),
    ))
    .all();
  return rows.find((s) => datedTimesOverlap(s.date, s.startTime, s.endTime, date, startTime, endTime)) ?? null;
}

function lockCheck(user: AuthUser, date: string, force: boolean | undefined) {
  const locked = isWeekLocked(user.activeRestaurantId, date);
  if (locked && !force) {
    throw new PlanningMutationError(423, WEEK_LOCKED_ERROR, { error: WEEK_LOCKED_ERROR, code: "WEEK_LOCKED", weekStart: getMonday(date) });
  }
  return locked;
}

function dayName(dateStr: string): string {
  return ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"][new Date(`${dateStr}T12:00:00`).getDay()];
}

function isUpcomingWithinNotifyWindow(dateStr: string, days = 15): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T12:00:00`).getTime();
  const diffDays = Math.floor((target - today.getTime()) / 86_400_000);
  return diffDays >= 0 && diffDays <= days;
}

export async function createPlanningService(user: AuthUser, input: {
  workerId: string;
  workerName?: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor";
  zone?: string;
}, options: PlanningMutationOptions = {}) {
  requirePermission(user, "PLANNING_EDIT");
  const locked = lockCheck(user, input.date, options.force);

  const [worker] = db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.id, input.workerId), eq(users.active, true)))
    .limit(1).all();
  if (!worker || !userCanBeScheduledInRestaurant(input.workerId, user.activeRestaurantId, [input.role])) {
    throw new PlanningMutationError(404, "Employé non trouvé");
  }

  const duplicate = db.select({ id: services.id })
    .from(services)
    .where(and(
      eq(services.workerId, input.workerId),
      eq(services.restaurantId, user.activeRestaurantId),
      eq(services.date, input.date),
      eq(services.startTime, input.startTime),
      eq(services.endTime, input.endTime),
      ne(services.status, "cancelled"),
    ))
    .limit(1).all()[0];
  if (duplicate) throw new PlanningMutationError(409, `Ce service existe déjà pour ${worker.name}`);

  const overlap = findOverlap(input.workerId, listOwnerRestaurantIdsForRestaurant(user.activeRestaurantId), input.date, input.startTime, input.endTime);
  if (overlap && !options.force) {
    throw new PlanningMutationError(409, `${worker.name} is already working this service (${overlap.startTime}–${overlap.endTime})`);
  }

  const [inserted] = db.insert(services).values({
    workerId: input.workerId,
    restaurantId: user.activeRestaurantId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    role: input.role,
  }).returning().all();

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "services",
    rowId: inserted.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    summary: `${locked ? "[Semaine verrouillée — override] " : ""}Ajouté service ${input.startTime}-${input.endTime} pour ${worker.name} (${input.date})`,
  });

  bumpCacheVersion(user.activeRestaurantId);

  if (options.notifyWorkers && input.workerId !== user.id && isUpcomingWithinNotifyWindow(input.date)) {
    const zone = input.zone || (parseInt(input.startTime.split(":")[0]) < 15 ? "Midi" : "Soir");
    await notifyScheduleChange(
      input.workerId,
      `📅 Ton planning a changé : ${user.name} t'a ajouté un service le ${dayName(input.date)} ${input.date} en *${zone}* (${input.startTime}-${input.endTime}).`,
      { workerName: worker.name, serviceLabel: `${dayName(input.date)} ${input.date} — ${zone}`, newSchedule: `${input.startTime}-${input.endTime}` },
      user.activeRestaurantId,
    ).catch(console.error);
  }

  return { service: inserted, workerName: worker.name, hours: serviceHours(input.startTime, input.endTime) };
}

export async function cancelPlanningService(user: AuthUser, input: { serviceId: string; zone?: string }, options: PlanningMutationOptions = {}) {
  requirePermission(user, "PLANNING_EDIT");

  const [existing] = db.select({
    id: services.id,
    workerId: services.workerId,
    date: services.date,
    startTime: services.startTime,
    endTime: services.endTime,
    status: services.status,
  }).from(services)
    .where(and(eq(services.id, input.serviceId), eq(services.restaurantId, user.activeRestaurantId)))
    .limit(1).all();
  if (!existing || existing.status === "cancelled") throw new PlanningMutationError(404, "Service not found");

  const locked = lockCheck(user, existing.date, options.force);
  const [updated] = db.update(services).set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(and(eq(services.id, input.serviceId), eq(services.restaurantId, user.activeRestaurantId)))
    .returning().all();

  const [worker] = db.select({ name: users.name }).from(users).where(eq(users.id, existing.workerId)).limit(1).all();
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "services",
    rowId: input.serviceId,
    action: "delete",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    changes: { status: { old: existing.status, new: "cancelled" } },
    summary: `${locked ? "[Semaine verrouillée — override] " : ""}Supprimé service ${existing.startTime}–${existing.endTime} de ${worker?.name ?? "?"} (${existing.date})`,
  });

  bumpCacheVersion(user.activeRestaurantId);

  if (options.notifyWorkers && existing.workerId !== user.id && isUpcomingWithinNotifyWindow(existing.date)) {
    const zone = input.zone || (parseInt(existing.startTime.split(":")[0]) < 15 ? "Midi" : "Soir");
    await notifyScheduleChange(
      existing.workerId,
      `📅 Ton planning a changé : ton service du ${dayName(existing.date)} ${existing.date} en *${zone}* (${existing.startTime}-${existing.endTime}) a été annulé par ${user.name}.`,
      { workerName: worker?.name, serviceLabel: `${dayName(existing.date)} ${existing.date} — ${zone}`, newSchedule: "annulé" },
      user.activeRestaurantId,
    ).catch(console.error);
  }

  return { service: updated, workerName: worker?.name ?? null };
}

export async function publishPlanningWeek(user: AuthUser, input: { weekStart: string }, options: PlanningMutationOptions = {}) {
  requirePermission(user, "PUBLISH_WEEK");
  const existing = db.select({ id: publishedWeeks.id }).from(publishedWeeks)
    .where(and(eq(publishedWeeks.restaurantId, user.activeRestaurantId), eq(publishedWeeks.weekDate, input.weekStart)))
    .limit(1).all()[0];
  if (existing) throw new PlanningMutationError(409, `Le planning ${input.weekStart} est déjà publié.`);

  const weekEndDate = new Date(`${input.weekStart}T12:00:00`);
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);
  const rows = db.select({ id: services.id })
    .from(services)
    .where(and(eq(services.restaurantId, user.activeRestaurantId), gte(services.date, input.weekStart), lte(services.date, weekEnd), ne(services.status, "cancelled")))
    .all();
  if (rows.length === 0) throw new PlanningMutationError(400, `Aucun service à publier pour la semaine ${input.weekStart}.`);

  const [row] = db.insert(publishedWeeks).values({
    restaurantId: user.activeRestaurantId,
    weekDate: input.weekStart,
    publishedAt: new Date().toISOString(),
  }).returning({ id: publishedWeeks.id }).all();

  const notifiedWorkers = options.notifyWorkers === false ? 0 : await notifyWorkersWeekPublished(user.activeRestaurantId, input.weekStart);
  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "published_weeks",
    rowId: row.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    changes: { published: { old: false, new: true }, weekDate: { new: input.weekStart } },
    summary: `Planning publié via ${options.source === "bot:admin" ? "WhatsApp" : "dashboard"} pour la semaine ${input.weekStart} — ${notifiedWorkers} employés notifiés`,
  });

  return { weekStart: input.weekStart, weekEnd, serviceCount: rows.length, notifiedWorkers };
}

/** Default "Midi"/"Soir" inference when the caller doesn't have an explicit zone label. */
function inferZoneLabel(startTime: string): string {
  return parseInt(startTime.split(":")[0]) < 15 ? "Midi" : "Soir";
}

type ServiceSnapshot = { workerId: string; date: string; startTime: string; endTime: string };

/**
 * Fire WhatsApp schedule-change notifications when a dashboard edit modifies a
 * service that's already in a published week and within the next 15 days.
 * Three cases:
 *  - worker reassigned → old worker gets a "service retiré" message, new worker
 *    gets a "service ajouté" message
 *  - date moved (same worker) → that worker gets a "service déplacé" message
 *  - time edited (same worker, same date) → that worker gets a "horaires changés" message
 *
 * The editor is never notified about their own action. Notifications fire and
 * forget — failures are logged but don't block the API response.
 */
export async function notifyDashboardServiceUpdate(
  user: AuthUser,
  existing: ServiceSnapshot,
  updated: ServiceSnapshot,
): Promise<void> {
  const workerChanged = existing.workerId !== updated.workerId;
  const dateChanged = existing.date !== updated.date;
  const timeChanged = existing.startTime !== updated.startTime || existing.endTime !== updated.endTime;
  if (!workerChanged && !dateChanged && !timeChanged) return;

  const oldPublishedAndUpcoming = isWeekPublished(user.activeRestaurantId, getMonday(existing.date))
    && isUpcomingWithinNotifyWindow(existing.date);
  const newPublishedAndUpcoming = isWeekPublished(user.activeRestaurantId, getMonday(updated.date))
    && isUpcomingWithinNotifyWindow(updated.date);
  if (!oldPublishedAndUpcoming && !newPublishedAndUpcoming) return;

  const [oldWorker] = db.select({ name: users.name }).from(users).where(eq(users.id, existing.workerId)).limit(1).all();
  const [newWorker] = workerChanged
    ? db.select({ name: users.name }).from(users).where(eq(users.id, updated.workerId)).limit(1).all()
    : [oldWorker];

  if (workerChanged) {
    if (oldPublishedAndUpcoming && existing.workerId !== user.id) {
      const zone = inferZoneLabel(existing.startTime);
      await notifyScheduleChange(
        existing.workerId,
        `📅 Ton planning a changé : ton service du ${dayName(existing.date)} ${existing.date} en *${zone}* (${existing.startTime}-${existing.endTime}) a été retiré par ${user.name}.`,
        { workerName: oldWorker?.name, serviceLabel: `${dayName(existing.date)} ${existing.date} — ${zone}`, newSchedule: "retiré" },
        user.activeRestaurantId,
      ).catch((e) => console.error("[planning-notify] old-worker failed:", e));
    }
    if (newPublishedAndUpcoming && updated.workerId !== user.id) {
      const zone = inferZoneLabel(updated.startTime);
      await notifyScheduleChange(
        updated.workerId,
        `📅 Ton planning a changé : ${user.name} t'a ajouté un service le ${dayName(updated.date)} ${updated.date} en *${zone}* (${updated.startTime}-${updated.endTime}).`,
        { workerName: newWorker?.name, serviceLabel: `${dayName(updated.date)} ${updated.date} — ${zone}`, newSchedule: `${updated.startTime}-${updated.endTime}` },
        user.activeRestaurantId,
      ).catch((e) => console.error("[planning-notify] new-worker failed:", e));
    }
    return;
  }

  // Same worker — only one notification, but content depends on what changed.
  if (updated.workerId === user.id) return;
  if (!newPublishedAndUpcoming && !oldPublishedAndUpcoming) return;

  if (dateChanged) {
    await notifyScheduleChange(
      updated.workerId,
      `📅 Ton planning a changé : ton service du ${dayName(existing.date)} ${existing.date} (${existing.startTime}-${existing.endTime}) a été déplacé au ${dayName(updated.date)} ${updated.date} (${updated.startTime}-${updated.endTime}) par ${user.name}.`,
      { workerName: newWorker?.name, serviceLabel: `${dayName(updated.date)} ${updated.date}`, newSchedule: `${updated.startTime}-${updated.endTime}` },
      user.activeRestaurantId,
    ).catch((e) => console.error("[planning-notify] move failed:", e));
    return;
  }

  if (timeChanged) {
    const zone = inferZoneLabel(updated.startTime);
    await notifyScheduleChange(
      updated.workerId,
      `📅 Ton planning a changé : tes horaires du ${dayName(updated.date)} ${updated.date} en *${zone}* sont désormais ${updated.startTime}-${updated.endTime} (avant ${existing.startTime}-${existing.endTime}) — modifié par ${user.name}.`,
      { workerName: newWorker?.name, serviceLabel: `${dayName(updated.date)} ${updated.date} — ${zone}`, newSchedule: `${updated.startTime}-${updated.endTime}` },
      user.activeRestaurantId,
    ).catch((e) => console.error("[planning-notify] time-edit failed:", e));
  }
}
