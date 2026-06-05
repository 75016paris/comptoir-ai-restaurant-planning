import { and, desc, eq, gte, lte, or } from "drizzle-orm";
import { todayInTimeZone } from "@comptoir/shared";
import { db } from "../db/connection.js";
import { holidayRequests, restaurants, users } from "../db/schema.js";
import type { AuthUser } from "../middleware/auth.js";
import { logAudit, type AuditSource } from "../db/audit.js";
import { adminRecipientsForRestaurant, notifyAdminHolidayRequest } from "./notifications.js";
import { bumpCacheVersion } from "./baseline-cache.js";
import { userHasActiveRestaurantMembership } from "./restaurant-context.js";

export class WorkerHolidayError extends Error {
  constructor(public status: 400 | 403 | 409, message: string) {
    super(message);
    this.name = "WorkerHolidayError";
  }
}

function assertDirectHolidayMembership(user: AuthUser) {
  if (userHasActiveRestaurantMembership(user.id, user.activeRestaurantId)) return;
  throw new WorkerHolidayError(
    403,
    "Les congés restent liés à ton restaurant employeur. Change de contexte vers ton restaurant principal pour gérer tes congés.",
  );
}

function overlappingHolidayExists(restaurantId: string, workerId: string, startDate: string, endDate: string): boolean {
  const row = db.select({ id: holidayRequests.id })
    .from(holidayRequests)
    .where(and(
      eq(holidayRequests.workerId, workerId),
      eq(holidayRequests.restaurantId, restaurantId),
      or(eq(holidayRequests.status, "pending"), eq(holidayRequests.status, "approved"))!,
      lte(holidayRequests.startDate, endDate),
      gte(holidayRequests.endDate, startDate),
    ))
    .limit(1)
    .all()[0];
  return Boolean(row);
}

export function listOwnHolidays(user: AuthUser) {
  assertDirectHolidayMembership(user);
  return db.select({
    id: holidayRequests.id,
    startDate: holidayRequests.startDate,
    endDate: holidayRequests.endDate,
    status: holidayRequests.status,
    reason: holidayRequests.reason,
    medical: holidayRequests.medical,
    createdAt: holidayRequests.createdAt,
  })
    .from(holidayRequests)
    .where(and(eq(holidayRequests.workerId, user.id), eq(holidayRequests.restaurantId, user.activeRestaurantId)))
    .orderBy(desc(holidayRequests.createdAt))
    .limit(5)
    .all();
}

export async function createOwnHolidayRequest(user: AuthUser, input: {
  startDate: string;
  endDate: string;
  reason?: string | null;
}, options: { source?: AuditSource } = {}) {
  assertDirectHolidayMembership(user);
  if (input.endDate < input.startDate) throw new WorkerHolidayError(400, "La date de fin doit être après la date de début.");
  const today = todayInTimeZone(user.restaurantTimezone);
  if (input.startDate < today) throw new WorkerHolidayError(400, "Impossible de demander un congé dans le passé.");
  if (overlappingHolidayExists(user.activeRestaurantId, user.id, input.startDate, input.endDate)) {
    throw new WorkerHolidayError(409, "Tu as déjà une demande de congé en cours pour ces dates. Vérifie tes congés avec *mes congés*.");
  }

  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  const [restaurant] = db.select({ medicalMode: restaurants.medicalMode })
    .from(restaurants).where(eq(restaurants.id, user.activeRestaurantId)).limit(1).all();
  const isMedical = Boolean(restaurant?.medicalMode && /m[eé]dical|maladie|malade|arr[eê]t.?maladie|sick/i.test(reason || ""));
  const storedReason = isMedical ? null : reason;

  const [request] = db.insert(holidayRequests).values({
    workerId: user.id,
    restaurantId: user.activeRestaurantId,
    startDate: input.startDate,
    endDate: input.endDate,
    reason: storedReason,
    ...(isMedical ? { medical: true, status: "approved" as const } : {}),
  }).returning().all();

  logAudit({
    restaurantId: user.activeRestaurantId,
    tableName: "holiday_requests",
    rowId: request.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: options.source ?? "dashboard",
    summary: `Demande de congé ${input.startDate} → ${input.endDate}${storedReason ? ` (${storedReason})` : ""}${isMedical ? " [médical, auto-approuvé]" : ""}`,
  });

  const [admin] = adminRecipientsForRestaurant(user.activeRestaurantId, ["admin"]);
  if (admin) {
    notifyAdminHolidayRequest(admin.id, user.name || "Un employé", input.startDate, input.endDate, isMedical, user.activeRestaurantId).catch(console.error);
  }

  bumpCacheVersion(user.activeRestaurantId);
  return { request, isMedical };
}
