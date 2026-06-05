/**
 * In-app alerts for admins/managers — surfaces server-side events the user
 * should see on next app open (e.g. "worker X completed their dossier").
 * Distinct from the outbound `notifications` table which delivers via WA/SMS.
 */
import { Hono } from "hono";
import { eq, and, desc, isNull, inArray } from "drizzle-orm";
import { type AppEnv, requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { db } from "../db/connection.js";
import { adminAlerts } from "../db/schema.js";

export const adminAlertsRoutes = new Hono<AppEnv>();
adminAlertsRoutes.use("*", requireAuth);
adminAlertsRoutes.use("*", requireActiveSubscription);

// GET /admin-alerts?unseen=1 — list alerts addressed to the current user
adminAlertsRoutes.get("/", (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (user.role !== "admin" && user.role !== "manager") return c.json({ data: [] });

  const onlyUnseen = c.req.query("unseen") === "1";
  const conds = [eq(adminAlerts.recipientId, user.id), eq(adminAlerts.restaurantId, restaurant.restaurantId)];
  if (onlyUnseen) conds.push(isNull(adminAlerts.seenAt));

  const rows = db.select().from(adminAlerts)
    .where(and(...conds))
    .orderBy(desc(adminAlerts.createdAt))
    .limit(50)
    .all();

  return c.json({ data: rows });
});

// POST /admin-alerts/mark-seen — { ids: string[] }  (or omit ids → mark all unseen)
adminAlertsRoutes.post("/mark-seen", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (user.role !== "admin" && user.role !== "manager") return c.json({ data: { ok: true } });

  const body = await c.req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];
  const now = new Date().toISOString();

  if (ids.length > 0) {
    db.update(adminAlerts).set({ seenAt: now })
      .where(and(eq(adminAlerts.recipientId, user.id), eq(adminAlerts.restaurantId, restaurant.restaurantId), inArray(adminAlerts.id, ids), isNull(adminAlerts.seenAt)))
      .run();
  } else {
    db.update(adminAlerts).set({ seenAt: now })
      .where(and(eq(adminAlerts.recipientId, user.id), eq(adminAlerts.restaurantId, restaurant.restaurantId), isNull(adminAlerts.seenAt)))
      .run();
  }

  return c.json({ data: { ok: true } });
});
