import { and, asc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { can, formatInstantInTimeZone, todayInTimeZone, zonedDateParts, zonedDateTimeToUtc } from "@comptoir/shared";
import { logAudit, type AuditSource } from "../db/audit.js";
import { db } from "../db/connection.js";
import { publishedWeeks, restaurants, services, timeClocks, users } from "../db/schema.js";
import type { AuthUser } from "../middleware/auth.js";
import { getMonday } from "../utils/scheduling.js";
import { adminRecipientsForRestaurant, messageWithRestaurantContext, notify } from "./notifications.js";
import { userHasActiveRestaurantMembership } from "./restaurant-context.js";

export class TimeclockActionError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "TimeclockActionError";
  }
}

function tapInOutEnabled(restaurantId: string): boolean {
  const [row] = db.select({ tapInOutEnabled: restaurants.tapInOutEnabled })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();
  return !!row?.tapInOutEnabled;
}

function fmtHHMM(iso: string, timeZone: string): string {
  return formatInstantInTimeZone(iso, "fr-FR", timeZone, { year: undefined, month: undefined, day: undefined });
}

function isVisibleOwnService(user: AuthUser, service: { role: string }): boolean {
  if (userHasActiveRestaurantMembership(user.id, user.activeRestaurantId)) return true;
  return user.role === service.role;
}

async function notifyAdminOfTapEvent(
  restaurantId: string,
  workerId: string,
  workerName: string,
  kind: "in" | "out",
  whenIso: string,
) {
  const [restaurant] = db.select({ confirm: restaurants.tapInOutAdminConfirmation, timezone: restaurants.timezone })
    .from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  if (!restaurant?.confirm) return;
  const [admin] = adminRecipientsForRestaurant(restaurantId);
  if (!admin || admin.id === workerId) return;
  const action = kind === "in" ? "arrivée" : "départ";
  const message = `${workerName} a pointé son ${action} à ${fmtHHMM(whenIso, restaurant.timezone)}. Répondez OUI pour confirmer ce pointage, ou ajustez l'heure depuis le tableau de bord.`;
  await notify({
    recipientId: admin.id,
    type: "time_clock_confirm",
    message: messageWithRestaurantContext(admin.id, restaurantId, message),
  });
}

function closestServiceForClockIn(user: AuthUser, now: Date): string | null {
  const date = todayInTimeZone(user.restaurantTimezone, now);
  const todayServices = db
    .select({ id: services.id, startTime: services.startTime, role: services.role })
    .from(services)
    .where(and(
      eq(services.workerId, user.id),
      eq(services.restaurantId, user.activeRestaurantId),
      eq(services.date, date),
      ne(services.status, "cancelled"),
    ))
    .all()
    .filter((service) => isVisibleOwnService(user, service));
  const nowParts = zonedDateParts(now, user.restaurantTimezone);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  let matched: string | null = null;
  let minDiff = Infinity;
  for (const s of todayServices) {
    const [h, m] = s.startTime.split(":").map(Number);
    const diff = Math.abs((h * 60 + m) - nowMinutes);
    if (diff < minDiff) {
      minDiff = diff;
      matched = s.id;
    }
  }
  return matched;
}

export async function clockInUser(user: AuthUser, options: { source?: AuditSource; now?: Date } = {}) {
  if (!tapInOutEnabled(user.activeRestaurantId)) {
    throw new TimeclockActionError(403, "Le pointage n'est pas activé pour ton restaurant.");
  }
  const existing = db.select({ id: timeClocks.id }).from(timeClocks)
    .where(and(eq(timeClocks.userId, user.id), eq(timeClocks.restaurantId, user.activeRestaurantId), isNull(timeClocks.tapOut)))
    .limit(1).all()[0];
  if (existing) throw new TimeclockActionError(409, "Tu es déjà pointé(e). Dis 'pointer sortie' pour terminer.");

  const now = options.now ?? new Date();
  const [record] = db.insert(timeClocks).values({
    userId: user.id,
    restaurantId: user.activeRestaurantId,
    serviceId: closestServiceForClockIn(user, now),
    tapIn: now.toISOString(),
    date: todayInTimeZone(user.restaurantTimezone, now),
  }).returning().all();

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "time_clocks",
    rowId: record.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    summary: `Pointage entrée ${fmtHHMM(record.tapIn, user.restaurantTimezone)}`,
  });
  await notifyAdminOfTapEvent(user.activeRestaurantId, user.id, user.name, "in", record.tapIn);
  return record;
}

export async function clockOutUser(user: AuthUser, options: { source?: AuditSource; now?: Date } = {}) {
  if (!tapInOutEnabled(user.activeRestaurantId)) {
    throw new TimeclockActionError(403, "Le pointage n'est pas activé pour ton restaurant.");
  }
  const active = db.select().from(timeClocks)
    .where(and(eq(timeClocks.userId, user.id), eq(timeClocks.restaurantId, user.activeRestaurantId), isNull(timeClocks.tapOut)))
    .orderBy(timeClocks.tapIn)
    .limit(1).all()[0];
  if (!active) throw new TimeclockActionError(400, "Tu n'es pas pointé(e) actuellement.");

  const now = options.now ?? new Date();
  const [updated] = db.update(timeClocks).set({ tapOut: now.toISOString() })
    .where(eq(timeClocks.id, active.id))
    .returning().all();

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "time_clocks",
    rowId: active.id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    changes: { tapOut: { old: null, new: updated.tapOut } },
    summary: `Pointage sortie ${fmtHHMM(updated.tapOut!, user.restaurantTimezone)}`,
  });
  await notifyAdminOfTapEvent(user.activeRestaurantId, user.id, user.name, "out", updated.tapOut!);
  return updated;
}

export function confirmOldestPendingTimeclock(user: AuthUser) {
  if (!can(user, "HOURS_VIEW")) {
    throw new TimeclockActionError(403, "Accès refusé.");
  }
  const [pending] = db.select({ id: timeClocks.id, workerName: users.name, tapIn: timeClocks.tapIn, tapOut: timeClocks.tapOut })
    .from(timeClocks)
    .innerJoin(users, eq(users.id, timeClocks.userId))
    .where(and(
      eq(timeClocks.restaurantId, user.activeRestaurantId),
      isNull(timeClocks.adminConfirmedAt),
    ))
    .orderBy(asc(timeClocks.createdAt))
    .limit(1)
    .all();
  if (!pending) throw new TimeclockActionError(404, "Aucun pointage en attente de confirmation.");

  const now = new Date().toISOString();
  const [updated] = db.update(timeClocks)
    .set({ adminConfirmedAt: now, adminConfirmedBy: user.id })
    .where(eq(timeClocks.id, pending.id))
    .returning()
    .all();

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "time_clocks",
    rowId: pending.id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "bot:admin",
    changes: { adminConfirmedAt: { old: null, new: now }, adminConfirmedBy: { old: null, new: user.id } },
    summary: `Confirmation pointage ${pending.workerName}`,
  });
  return { ...updated, workerName: pending.workerName };
}

function serviceMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

export function getOwnHours(user: AuthUser, from: string, to: string) {
  let rows = db.select({ id: services.id, date: services.date, startTime: services.startTime, endTime: services.endTime, role: services.role, status: services.status })
    .from(services)
    .where(and(eq(services.workerId, user.id), eq(services.restaurantId, user.activeRestaurantId), gte(services.date, from), lte(services.date, to), ne(services.status, "cancelled")))
    .orderBy(services.date)
    .all()
    .filter((service) => isVisibleOwnService(user, service));

  const mondays = Array.from(new Set(rows.map((s) => getMonday(s.date))));
  if (mondays.length > 0) {
    const publishedRows = db.select({ weekDate: publishedWeeks.weekDate })
      .from(publishedWeeks)
      .where(and(eq(publishedWeeks.restaurantId, user.activeRestaurantId), inArray(publishedWeeks.weekDate, mondays)))
      .all();
    const published = new Set(publishedRows.map((r) => r.weekDate));
    rows = rows.filter((s) => published.has(getMonday(s.date)));
  }

  const [restaurant] = db.select({ tapInOutMode: restaurants.tapInOutMode, tapInCountsAsHours: restaurants.tapInCountsAsHours })
    .from(restaurants).where(eq(restaurants.id, user.activeRestaurantId)).limit(1).all();
  const syncMode = restaurant?.tapInOutMode === "sync";
  const tapInCountsEarly = !!restaurant?.tapInCountsAsHours;
  const taps = syncMode ? db.select({ serviceId: timeClocks.serviceId, tapIn: timeClocks.tapIn, tapOut: timeClocks.tapOut })
    .from(timeClocks)
    .where(and(eq(timeClocks.restaurantId, user.activeRestaurantId), eq(timeClocks.userId, user.id), gte(timeClocks.date, from), lte(timeClocks.date, to)))
    .all() : [];
  const tapByServiceId = new Map(taps.filter((t) => t.serviceId).map((t) => [t.serviceId!, { tapIn: t.tapIn, tapOut: t.tapOut }]));

  const today = todayInTimeZone(user.restaurantTimezone);
  let totalMinutes = 0;
  for (const service of rows) {
    let minutes = serviceMinutes(service.startTime, service.endTime);
    if (syncMode && service.date <= today) {
      const tap = tapByServiceId.get(service.id);
      if (tap) {
        const scheduledStart = zonedDateTimeToUtc(service.date, service.startTime, user.restaurantTimezone);
        const scheduledEndBase = zonedDateTimeToUtc(service.date, service.endTime, user.restaurantTimezone);
        const scheduledEnd = scheduledEndBase <= scheduledStart
          ? new Date(scheduledEndBase.getTime() + 24 * 60 * 60 * 1000)
          : scheduledEndBase;
        const tapInMs = new Date(tap.tapIn).getTime();
        const startMs = tapInCountsEarly ? Math.min(tapInMs, scheduledStart.getTime()) : Math.max(tapInMs, scheduledStart.getTime());
        const endMs = tap.tapOut ? new Date(tap.tapOut).getTime() : scheduledEnd.getTime();
        minutes = Math.max(0, Math.round((endMs - startMs) / 60000));
      }
    }
    totalMinutes += minutes;
  }

  return {
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    serviceCount: rows.length,
    services: rows,
  };
}
