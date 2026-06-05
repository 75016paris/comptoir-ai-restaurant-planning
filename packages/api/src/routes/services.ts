import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { services, users, timeClocks, replacementRequests, openShifts, publishedWeeks } from "../db/schema.js";
import { eq, and, gte, lte, ne, inArray } from "drizzle-orm";
import { requireAuth, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { can, createServiceSchema, updateServiceSchema, moveServiceSchema, flattenZodError } from "@comptoir/shared";
import { logAudit, diff } from "../db/audit.js";
import { getMonday } from "../utils/scheduling.js";
import { isWeekLocked, WEEK_LOCKED_ERROR } from "../utils/week-lock.js";
import { bumpCacheVersion } from "../services/baseline-cache.js";
import { notifyDashboardServiceUpdate } from "../services/planning-mutations.js";
import { listOwnerRestaurantIdsForRestaurant, userCanBeScheduledInRestaurant } from "../services/restaurant-context.js";

export const serviceRoutes = new Hono<AppEnv>();

serviceRoutes.use("*", requireAuth);
serviceRoutes.use("*", requireActiveSubscription);

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

// Check for overlapping services for a worker on a given date/time range
// Returns the overlapping service with worker name if found, null otherwise
function findOverlap(
  workerId: string,
  restaurantIds: string[],
  date: string,
  startTime: string,
  endTime: string,
  excludeServiceId?: string,
) {
  const conditions = [
    eq(services.workerId, workerId),
    restaurantIds.length > 1 ? inArray(services.restaurantId, restaurantIds) : eq(services.restaurantId, restaurantIds[0]),
    inArray(services.date, [offsetDate(date, -1), date, offsetDate(date, 1)]),
    ne(services.status, "cancelled"),
  ];
  if (excludeServiceId) {
    conditions.push(ne(services.id, excludeServiceId));
  }

  // Fetch all services for this worker on this date, then check overlap in JS
  // (SQL string comparison fails for overnight services where endTime < startTime)
  const dayServices = db
    .select({ id: services.id, workerName: users.name, date: services.date, startTime: services.startTime, endTime: services.endTime })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(and(...conditions))
    .all();

  for (const s of dayServices) {
    if (datedTimesOverlap(s.date, s.startTime, s.endTime, date, startTime, endTime)) {
      return s;
    }
  }
  return null;
}

// GET /services?from=2026-03-20&to=2026-03-27
serviceRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!from || !to) {
    return c.json({ error: "from and to query params required" }, 400);
  }

  const result = db
    .select({
      id: services.id,
      workerId: services.workerId,
      workerName: users.name,
      workerRole: users.role,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      role: services.role,
      status: services.status,
      notes: services.notes,
    })
    .from(services)
    .innerJoin(users, eq(services.workerId, users.id))
    .where(
      and(
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, from),
        lte(services.date, to)
      )
    )
    .orderBy(services.date, services.startTime)
    .all();

  // Workers only see shifts in published weeks; admins/managers see drafts too.
  if (!can(user, "PLANNING_EDIT")) {
    const mondays = Array.from(new Set(result.map((s) => getMonday(s.date))));
    if (mondays.length === 0) {
      return c.json({ data: [] });
    }
    const publishedRows = db.select({ weekDate: publishedWeeks.weekDate })
      .from(publishedWeeks)
      .where(and(
        eq(publishedWeeks.restaurantId, restaurant.restaurantId),
        inArray(publishedWeeks.weekDate, mondays),
      ))
      .all();
    const publishedSet = new Set(publishedRows.map((r) => r.weekDate));
    return c.json({ data: result.filter((s) => publishedSet.has(getMonday(s.date))) });
  }

  return c.json({ data: result });
});

// POST /services
serviceRoutes.post("/", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const parsed = createServiceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const forced = c.req.query("force") === "true";
  const locked = isWeekLocked(restaurant.restaurantId, parsed.data.date);
  if (locked && !forced) {
    return c.json({ error: WEEK_LOCKED_ERROR, code: "WEEK_LOCKED", weekStart: getMonday(parsed.data.date) }, 423);
  }

  // Verify worker belongs to this restaurant
  const [worker] = db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, parsed.data.workerId), eq(users.active, true)))
    .limit(1).all();
  if (!worker || !userCanBeScheduledInRestaurant(parsed.data.workerId, restaurant.restaurantId, [parsed.data.role])) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const overlap = findOverlap(
    parsed.data.workerId,
    listOwnerRestaurantIdsForRestaurant(restaurant.restaurantId),
    parsed.data.date,
    parsed.data.startTime,
    parsed.data.endTime,
  );
  if (overlap) {
    return c.json({
      error: `${overlap.workerName} is already working this service (${overlap.startTime}–${overlap.endTime})`,
    }, 409);
  }

  const [service] = db
    .insert(services)
    .values({
      ...parsed.data,
      restaurantId: restaurant.restaurantId,
    })
    .returning()
    .all();

  const workerRow = db.select({ name: users.name }).from(users).where(eq(users.id, parsed.data.workerId)).all()[0];
  const prefix = locked && forced ? "[Semaine verrouillée — override] " : "";
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "services",
    rowId: service.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: diff(null, service),
    summary: `${prefix}Créé service ${service.startTime}–${service.endTime} pour ${workerRow?.name ?? "?"} (${service.date})`,
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: service }, 201);
});

// PATCH /services/:id
serviceRoutes.patch("/:id", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = updateServiceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  // Fetch existing service to merge fields for overlap check
  const existing = db.select().from(services)
    .where(and(eq(services.id, id), eq(services.restaurantId, restaurant.restaurantId)))
    .all()[0];
  if (!existing) {
    return c.json({ error: "Service not found" }, 404);
  }

  const newDate = parsed.data.date ?? existing.date;
  const newStart = parsed.data.startTime ?? existing.startTime;
  const newEnd = parsed.data.endTime ?? existing.endTime;
  const newWorker = parsed.data.workerId ?? existing.workerId;
  const newRole = parsed.data.role ?? existing.role;

  const forced = c.req.query("force") === "true";
  const lockedOld = isWeekLocked(restaurant.restaurantId, existing.date);
  const lockedNew = existing.date !== newDate ? isWeekLocked(restaurant.restaurantId, newDate) : false;
  const locked = lockedOld || lockedNew;
  if (locked && !forced) {
    return c.json({ error: WEEK_LOCKED_ERROR, code: "WEEK_LOCKED", weekStart: getMonday(lockedOld ? existing.date : newDate) }, 423);
  }

  // Revalidate the final worker/role pair whenever either side changes. This
  // keeps accepted shared workers bound to the exact role they consented to.
  if ((parsed.data.workerId && parsed.data.workerId !== existing.workerId) || (parsed.data.role && parsed.data.role !== existing.role)) {
    const [worker] = db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, newWorker), eq(users.active, true)))
      .limit(1).all();
    if (!worker || !userCanBeScheduledInRestaurant(newWorker, restaurant.restaurantId, [newRole as "kitchen" | "floor"])) {
      return c.json({ error: "Employé non trouvé" }, 404);
    }
  }

  const overlap = findOverlap(newWorker, listOwnerRestaurantIdsForRestaurant(restaurant.restaurantId), newDate, newStart, newEnd, id);
  if (overlap) {
    return c.json({
      error: `${overlap.workerName} is already working this service (${overlap.startTime}–${overlap.endTime})`,
    }, 409);
  }

  const [updated] = db
    .update(services)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(and(eq(services.id, id), eq(services.restaurantId, restaurant.restaurantId)))
    .returning()
    .all();

  const prefix = locked && forced ? "[Semaine verrouillée — override] " : "";
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "services",
    rowId: id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: diff(existing, updated),
    summary: `${prefix}Modifié service ${id.slice(0, 8)} (${updated.date})`,
  });

  bumpCacheVersion(restaurant.restaurantId);

  notifyDashboardServiceUpdate(
    user,
    { workerId: existing.workerId, date: existing.date, startTime: existing.startTime, endTime: existing.endTime },
    { workerId: updated.workerId, date: updated.date, startTime: updated.startTime, endTime: updated.endTime },
  ).catch((e) => console.error("[services PATCH] notify failed:", e));

  return c.json({ data: updated });
});

// POST /services/move
serviceRoutes.post("/move", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const parsed = moveServiceSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const { serviceId, newDate, newStartTime, newEndTime, newWorkerId } = parsed.data;

  // Fetch existing service to merge fields for overlap check
  const existing = db.select().from(services)
    .where(and(eq(services.id, serviceId), eq(services.restaurantId, restaurant.restaurantId)))
    .all()[0];
  if (!existing) {
    return c.json({ error: "Service not found" }, 404);
  }

  // If reassigning to a different worker, verify they can work this service role.
  if (newWorkerId) {
    const [worker] = db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, newWorkerId), eq(users.active, true)))
      .limit(1).all();
    if (!worker || !userCanBeScheduledInRestaurant(newWorkerId, restaurant.restaurantId, [existing.role as "kitchen" | "floor"])) {
      return c.json({ error: "Employé non trouvé" }, 404);
    }
  }

  const finalDate = newDate ?? existing.date;
  const finalStart = newStartTime ?? existing.startTime;
  const finalEnd = newEndTime ?? existing.endTime;
  const finalWorker = newWorkerId ?? existing.workerId;

  const forced = c.req.query("force") === "true";
  const lockedOld = isWeekLocked(restaurant.restaurantId, existing.date);
  const lockedNew = existing.date !== finalDate ? isWeekLocked(restaurant.restaurantId, finalDate) : false;
  const locked = lockedOld || lockedNew;
  if (locked && !forced) {
    return c.json({ error: WEEK_LOCKED_ERROR, code: "WEEK_LOCKED", weekStart: getMonday(lockedOld ? existing.date : finalDate) }, 423);
  }

  const overlap = findOverlap(finalWorker, listOwnerRestaurantIdsForRestaurant(restaurant.restaurantId), finalDate, finalStart, finalEnd, serviceId);
  if (overlap) {
    return c.json({
      error: `${overlap.workerName} is already working this service (${overlap.startTime}–${overlap.endTime})`,
    }, 409);
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (newDate) updateData.date = newDate;
  if (newStartTime) updateData.startTime = newStartTime;
  if (newEndTime) updateData.endTime = newEndTime;
  if (newWorkerId) updateData.workerId = newWorkerId;

  const [updated] = db
    .update(services)
    .set(updateData)
    .where(and(eq(services.id, serviceId), eq(services.restaurantId, restaurant.restaurantId)))
    .returning()
    .all();

  const movePrefix = locked && forced ? "[Semaine verrouillée — override] " : "";
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "services",
    rowId: serviceId,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: diff(existing, updated),
    summary: `${movePrefix}Déplacé service ${serviceId.slice(0, 8)} → ${finalDate} ${finalStart}–${finalEnd}`,
  });

  bumpCacheVersion(restaurant.restaurantId);

  notifyDashboardServiceUpdate(
    user,
    { workerId: existing.workerId, date: existing.date, startTime: existing.startTime, endTime: existing.endTime },
    { workerId: updated.workerId, date: updated.date, startTime: updated.startTime, endTime: updated.endTime },
  ).catch((e) => console.error("[services move] notify failed:", e));

  return c.json({ data: updated });
});

// DELETE /services/:id
serviceRoutes.delete("/:id", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  // Fetch first so we can check the lock and report a useful error
  const existing = db.select({ date: services.date }).from(services)
    .where(and(eq(services.id, id), eq(services.restaurantId, restaurant.restaurantId)))
    .get();
  if (!existing) {
    return c.json({ error: "Service not found" }, 404);
  }

  const forced = c.req.query("force") === "true";
  const locked = isWeekLocked(restaurant.restaurantId, existing.date);
  if (locked && !forced) {
    return c.json({ error: WEEK_LOCKED_ERROR, code: "WEEK_LOCKED", weekStart: getMonday(existing.date) }, 423);
  }

  // Clean up FK references before deleting
  db.delete(timeClocks).where(eq(timeClocks.serviceId, id)).run();
  db.delete(replacementRequests).where(eq(replacementRequests.requesterServiceId, id)).run();
  db.update(openShifts).set({ status: "cancelled", serviceId: null }).where(eq(openShifts.serviceId, id)).run();

  const [deleted] = db
    .delete(services)
    .where(and(eq(services.id, id), eq(services.restaurantId, restaurant.restaurantId)))
    .returning()
    .all();

  if (!deleted) {
    return c.json({ error: "Service not found" }, 404);
  }

  const workerRow = db.select({ name: users.name }).from(users).where(eq(users.id, deleted.workerId)).all()[0];
  const prefix = locked && forced ? "[Semaine verrouillée — override] " : "";
  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "services",
    rowId: id,
    action: "delete",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    changes: diff(deleted, null),
    summary: `${prefix}Supprimé service ${deleted.startTime}–${deleted.endTime} de ${workerRow?.name ?? "?"} (${deleted.date})`,
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { ok: true } });
});
