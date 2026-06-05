import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { dailyRevenue, services } from "../db/schema.js";
import { eq, and, between } from "drizzle-orm";
import { requireAuth, requireAdmin, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";

export const revenueRoutes = new Hono<AppEnv>();

revenueRoutes.use("*", requireAuth);
revenueRoutes.use("*", requireActiveSubscription);
revenueRoutes.use("*", requireAdmin);

// GET /revenue?from=YYYY-MM-DD&to=YYYY-MM-DD
revenueRoutes.get("/", async (c) => {
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!from || !to) {
    return c.json({ error: "from and to query params required" }, 400);
  }

  const rows = db
    .select({
      id: dailyRevenue.id,
      date: dailyRevenue.date,
      amount: dailyRevenue.amount,
      notes: dailyRevenue.notes,
    })
    .from(dailyRevenue)
    .where(
      and(
        eq(dailyRevenue.restaurantId, restaurant.restaurantId),
        between(dailyRevenue.date, from, to)
      )
    )
    .orderBy(dailyRevenue.date)
    .all();

  return c.json({ data: rows });
});

// POST /revenue — log daily revenue (admin only)
revenueRoutes.post("/", requireAdmin, async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const { date, amount, notes } = body;

  if (!date || amount == null) {
    return c.json({ error: "date and amount required" }, 400);
  }

  // Upsert: delete existing entry for this date, then insert
  db.delete(dailyRevenue)
    .where(
      and(
        eq(dailyRevenue.restaurantId, restaurant.restaurantId),
        eq(dailyRevenue.date, date)
      )
    )
    .run();

  const [row] = db
    .insert(dailyRevenue)
    .values({
      restaurantId: restaurant.restaurantId,
      date,
      amount: Math.round(amount),
      notes: notes || null,
    })
    .returning()
    .all();

  return c.json({ data: row }, 201);
});

// GET /revenue/stats?from=YYYY-MM-DD&to=YYYY-MM-DD — revenue + per-worker stats
revenueRoutes.get("/stats", async (c) => {
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (!from || !to) {
    return c.json({ error: "from and to query params required" }, 400);
  }

  // Get revenue entries
  const revenues = db
    .select({
      date: dailyRevenue.date,
      amount: dailyRevenue.amount,
    })
    .from(dailyRevenue)
    .where(
      and(
        eq(dailyRevenue.restaurantId, restaurant.restaurantId),
        between(dailyRevenue.date, from, to)
      )
    )
    .orderBy(dailyRevenue.date)
    .all();

  // Get services for the same period
  const periodServices = db
    .select({
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
    })
    .from(services)
    .where(
      and(
        eq(services.restaurantId, restaurant.restaurantId),
        between(services.date, from, to)
      )
    )
    .all();

  // Build revenue-per-date map
  const revenueByDate = new Map<string, number>();
  let totalRevenue = 0;
  for (const r of revenues) {
    revenueByDate.set(r.date, r.amount);
    totalRevenue += r.amount;
  }

  // Calculate per-worker: revenue share based on hours worked on revenue days
  const workerHours: Record<string, number> = {};
  const workerRevenueDays: Record<string, Set<string>> = {};

  for (const s of periodServices) {
    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60;
    const hours = mins / 60;

    workerHours[s.workerId] = (workerHours[s.workerId] || 0) + hours;

    if (revenueByDate.has(s.date)) {
      if (!workerRevenueDays[s.workerId]) workerRevenueDays[s.workerId] = new Set();
      workerRevenueDays[s.workerId].add(s.date);
    }
  }

  // Revenue per worker: proportional to hours on days with revenue data
  const workerRevenue: Record<string, number> = {};
  for (const [date, amount] of revenueByDate) {
    const dayServices = periodServices.filter((s) => s.date === date);
    let totalDayHours = 0;
    const dayWorkerHours: Record<string, number> = {};

    for (const s of dayServices) {
      const [sh, sm] = s.startTime.split(":").map(Number);
      const [eh, em] = s.endTime.split(":").map(Number);
      let mins = (eh * 60 + em) - (sh * 60 + sm);
      if (mins < 0) mins += 24 * 60;
      const hours = mins / 60;
      dayWorkerHours[s.workerId] = (dayWorkerHours[s.workerId] || 0) + hours;
      totalDayHours += hours;
    }

    if (totalDayHours > 0) {
      for (const [wid, h] of Object.entries(dayWorkerHours)) {
        const share = (h / totalDayHours) * amount;
        workerRevenue[wid] = (workerRevenue[wid] || 0) + share;
      }
    }
  }

  return c.json({
    data: {
      totalRevenue,
      daysWithData: revenues.length,
      daily: revenues,
      avgDaily: revenues.length > 0 ? Math.round(totalRevenue / revenues.length) : 0,
      workerStats: Object.entries(workerHours).map(([workerId, hours]) => ({
        workerId,
        totalHours: Math.round(hours * 10) / 10,
        revenueShare: Math.round(workerRevenue[workerId] || 0),
        daysWorked: workerRevenueDays[workerId]?.size || 0,
        revenuePerHour: hours > 0 ? Math.round((workerRevenue[workerId] || 0) / hours) : 0,
      })),
    },
  });
});
