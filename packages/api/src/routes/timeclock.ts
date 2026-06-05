import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { timeClocks, services, restaurants, users as usersTbl } from "../db/schema.js";
import { eq, and, isNull, between } from "drizzle-orm";
import { requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { can, formatInstantInTimeZone, todayInTimeZone, zonedDateParts, zonedDateTimeToUtc } from "@comptoir/shared";
import { adminRecipientsForRestaurant, messageWithRestaurantContext, notify } from "../services/notifications.js";

function fmtHHMM(iso: string, timeZone: string): string {
  return formatInstantInTimeZone(iso, "fr-FR", timeZone, { year: undefined, month: undefined, day: undefined });
}

async function notifyAdminOfTapEvent(
  restaurantId: string,
  workerId: string,
  workerName: string,
  kind: "in" | "out",
  whenIso: string,
) {
  const [r] = db.select({ confirm: restaurants.tapInOutAdminConfirmation, timezone: restaurants.timezone })
    .from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  if (!r?.confirm) return;
  const admin = adminRecipientsForRestaurant(restaurantId, ["admin"])
    .find((recipient) => recipient.id !== workerId);
  if (!admin || admin.id === workerId) return;
  const action = kind === "in" ? "arrivée" : "départ";
  const message = `${workerName} a pointé son ${action} à ${fmtHHMM(whenIso, r.timezone)}. Répondez OUI pour confirmer ce pointage, ou ajustez l'heure depuis le tableau de bord.`;
  await notify({ recipientId: admin.id, type: "time_clock_confirm", message: messageWithRestaurantContext(admin.id, restaurantId, message) });
}

export const timeClockRoutes = new Hono<AppEnv>();

timeClockRoutes.use("*", requireAuth);
timeClockRoutes.use("*", requireActiveSubscription);

function tapInOutEnabled(restaurantId: string): boolean {
  const [row] = db.select({ tapInOutEnabled: restaurants.tapInOutEnabled })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();
  return !!row?.tapInOutEnabled;
}

// GET /timeclock/status — current clock status for the logged-in worker
timeClockRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);

  const [active] = db
    .select()
    .from(timeClocks)
    .where(
      and(
        eq(timeClocks.userId, user.id),
        eq(timeClocks.restaurantId, restaurant.restaurantId),
        isNull(timeClocks.tapOut)
      )
    )
    .limit(1)
    .all();

  return c.json({
    data: {
      clockedIn: !!active,
      current: active
        ? { id: active.id, tapIn: active.tapIn, serviceId: active.serviceId, date: active.date }
        : null,
    },
  });
});

// POST /timeclock/tap-in — clock in
timeClockRoutes.post("/tap-in", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  await c.req.json().catch(() => ({}));
  if (!tapInOutEnabled(restaurant.restaurantId)) {
    return c.json({ error: "Tap-in/out is disabled for this restaurant" }, 403);
  }
  const now = new Date();
  const date = todayInTimeZone(user.restaurantTimezone, now);

  // Check not already clocked in
  const [existing] = db
    .select({ id: timeClocks.id })
    .from(timeClocks)
    .where(
      and(
        eq(timeClocks.userId, user.id),
        eq(timeClocks.restaurantId, restaurant.restaurantId),
        isNull(timeClocks.tapOut)
      )
    )
    .limit(1)
    .all();

  if (existing) {
    return c.json({ error: "Already clocked in" }, 409);
  }

  // Try to match to a scheduled service today
  const todayServices = db
    .select({ id: services.id, startTime: services.startTime })
    .from(services)
    .where(
      and(
        eq(services.workerId, user.id),
        eq(services.restaurantId, restaurant.restaurantId),
        eq(services.date, date)
      )
    )
    .all();

  // Find closest service to now
  const nowParts = zonedDateParts(now, user.restaurantTimezone);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  let matchedServiceId: string | null = null;
  let minDiff = Infinity;
  for (const s of todayServices) {
    const [h, m] = s.startTime.split(":").map(Number);
    const diff = Math.abs((h * 60 + m) - nowMinutes);
    if (diff < minDiff) {
      minDiff = diff;
      matchedServiceId = s.id;
    }
  }

  const [record] = db
    .insert(timeClocks)
    .values({
      userId: user.id,
      restaurantId: restaurant.restaurantId,
      serviceId: matchedServiceId,
      tapIn: now.toISOString(),
      date,
    })
    .returning()
    .all();

  await notifyAdminOfTapEvent(restaurant.restaurantId, user.id, user.name, "in", record.tapIn);

  return c.json({
    data: { id: record.id, tapIn: record.tapIn, serviceId: record.serviceId, date: record.date },
  }, 201);
});

// POST /timeclock/tap-out — clock out
timeClockRoutes.post("/tap-out", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!tapInOutEnabled(restaurant.restaurantId)) {
    return c.json({ error: "Tap-in/out is disabled for this restaurant" }, 403);
  }
  const now = new Date();

  const [active] = db
    .select()
    .from(timeClocks)
    .where(
      and(
        eq(timeClocks.userId, user.id),
        eq(timeClocks.restaurantId, restaurant.restaurantId),
        isNull(timeClocks.tapOut)
      )
    )
    .limit(1)
    .all();

  if (!active) {
    return c.json({ error: "Not clocked in" }, 400);
  }

  const [updated] = db
    .update(timeClocks)
    .set({ tapOut: now.toISOString() })
    .where(eq(timeClocks.id, active.id))
    .returning()
    .all();

  await notifyAdminOfTapEvent(restaurant.restaurantId, user.id, user.name, "out", updated.tapOut!);

  return c.json({
    data: {
      id: updated.id,
      tapIn: updated.tapIn,
      tapOut: updated.tapOut,
      date: updated.date,
      serviceId: updated.serviceId,
    },
  });
});

// GET /timeclock/pending-confirmations — admin dashboard list of taps awaiting manager confirmation
timeClockRoutes.get("/pending-confirmations", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "HOURS_VIEW")) return c.json({ error: "Forbidden" }, 403);

  const rows = db.select({
    id: timeClocks.id,
    userId: timeClocks.userId,
    userName: usersTbl.name,
    tapIn: timeClocks.tapIn,
    tapOut: timeClocks.tapOut,
    date: timeClocks.date,
    serviceId: timeClocks.serviceId,
    adminConfirmedAt: timeClocks.adminConfirmedAt,
    adminConfirmedBy: timeClocks.adminConfirmedBy,
  })
    .from(timeClocks)
    .leftJoin(usersTbl, eq(usersTbl.id, timeClocks.userId))
    .where(and(eq(timeClocks.restaurantId, restaurant.restaurantId), isNull(timeClocks.adminConfirmedAt)))
    .orderBy(timeClocks.createdAt)
    .all();
  return c.json({ data: rows });
});

// POST /timeclock/:id/confirm — admin confirms a recorded tap
timeClockRoutes.post("/:id/confirm", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "HOURS_VIEW")) return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const [row] = db.select({ id: timeClocks.id })
    .from(timeClocks)
    .where(and(eq(timeClocks.id, id), eq(timeClocks.restaurantId, restaurant.restaurantId)))
    .limit(1)
    .all();
  if (!row) return c.json({ error: "Pointage introuvable" }, 404);
  const now = new Date().toISOString();
  const [updated] = db.update(timeClocks)
    .set({ adminConfirmedAt: now, adminConfirmedBy: user.id })
    .where(eq(timeClocks.id, id))
    .returning()
    .all();
  return c.json({ data: updated });
});

// GET /timeclock/lateness?workerId=&from=YYYY-MM-DD&to=YYYY-MM-DD — lateness records for a period
// Lateness = (actual tap-in - scheduled start) in minutes; only positive values shown.
// Early leave = (scheduled end - actual tap-out) in minutes; only positive values shown.
// Workers see only their own. Admins see any worker in their restaurant; workerId optional (defaults to all).
timeClockRoutes.get("/lateness", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");
  const workerIdQ = c.req.query("workerId");
  if (!from || !to) return c.json({ error: "from and to required" }, 400);

  const targetWorkerId = can(user, "HOURS_VIEW") ? (workerIdQ ?? null) : user.id;

  const conditions = [
    eq(timeClocks.restaurantId, restaurant.restaurantId),
    between(timeClocks.date, from, to),
  ];
  if (targetWorkerId) conditions.push(eq(timeClocks.userId, targetWorkerId));

  const rows = db
    .select({
      id: timeClocks.id,
      userId: timeClocks.userId,
      userName: usersTbl.name,
      date: timeClocks.date,
      tapIn: timeClocks.tapIn,
      tapOut: timeClocks.tapOut,
      serviceId: timeClocks.serviceId,
      scheduledStart: services.startTime,
      scheduledEnd: services.endTime,
    })
    .from(timeClocks)
    .leftJoin(services, eq(services.id, timeClocks.serviceId))
    .leftJoin(usersTbl, eq(usersTbl.id, timeClocks.userId))
    .where(and(...conditions))
    .orderBy(timeClocks.date)
    .all();

  const records = rows
    .map((r) => {
      if (!r.scheduledStart) return null; // unmatched tap, can't compute lateness
      const tapIn = new Date(r.tapIn);
      const scheduledStart = zonedDateTimeToUtc(r.date, r.scheduledStart, user.restaurantTimezone);
      const lateMin = Math.round((tapIn.getTime() - scheduledStart.getTime()) / 60000);

      let earlyLeaveMin = 0;
      if (r.tapOut && r.scheduledEnd) {
        const tapOut = new Date(r.tapOut);
        const scheduledEndBase = zonedDateTimeToUtc(r.date, r.scheduledEnd, user.restaurantTimezone);
        const scheduledEnd = scheduledEndBase <= scheduledStart
          ? new Date(scheduledEndBase.getTime() + 24 * 60 * 60 * 1000)
          : scheduledEndBase;
        earlyLeaveMin = Math.round((scheduledEnd.getTime() - tapOut.getTime()) / 60000);
      }

      return {
        id: r.id,
        userId: r.userId,
        userName: r.userName ?? "—",
        date: r.date,
        tapIn: r.tapIn,
        tapOut: r.tapOut,
        scheduledStart: r.scheduledStart,
        scheduledEnd: r.scheduledEnd,
        lateMin: Math.max(0, lateMin),
        earlyLeaveMin: Math.max(0, earlyLeaveMin),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && (r.lateMin > 0 || r.earlyLeaveMin > 0));

  // Aggregate per worker for the period
  const byWorker = new Map<string, { userId: string; userName: string; totalLateMin: number; totalEarlyLeaveMin: number; count: number }>();
  for (const r of records) {
    const cur = byWorker.get(r.userId) ?? { userId: r.userId, userName: r.userName, totalLateMin: 0, totalEarlyLeaveMin: 0, count: 0 };
    cur.totalLateMin += r.lateMin;
    cur.totalEarlyLeaveMin += r.earlyLeaveMin;
    cur.count += 1;
    byWorker.set(r.userId, cur);
  }

  return c.json({ data: { records, totals: Array.from(byWorker.values()) } });
});

// GET /timeclock?from=YYYY-MM-DD&to=YYYY-MM-DD — clock records for a period (admin sees all, worker sees own)
timeClockRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!from || !to) {
    return c.json({ error: "from and to required" }, 400);
  }

  const conditions = [
    eq(timeClocks.restaurantId, restaurant.restaurantId),
    between(timeClocks.date, from, to),
  ];

  // Workers only see their own records
  if (!can(user, "HOURS_VIEW")) {
    conditions.push(eq(timeClocks.userId, user.id));
  }

  const records = db
    .select({
      id: timeClocks.id,
      userId: timeClocks.userId,
      serviceId: timeClocks.serviceId,
      tapIn: timeClocks.tapIn,
      tapOut: timeClocks.tapOut,
      date: timeClocks.date,
    })
    .from(timeClocks)
    .where(and(...conditions))
    .orderBy(timeClocks.date)
    .all();

  return c.json({ data: records });
});
