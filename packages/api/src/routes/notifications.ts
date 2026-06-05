import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { notifications, users } from "../db/schema.js";
import { eq, and, desc, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { can } from "@comptoir/shared";
import { processQueue } from "../services/notifications.js";
import { listRestaurantMemberUserIds } from "../services/restaurant-context.js";

export const notificationRoutes = new Hono<AppEnv>();
notificationRoutes.use("*", requireAuth);
notificationRoutes.use("*", requireActiveSubscription);

// GET /notifications — list notifications for current user (worker) or all (admin)
notificationRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const limit = Number(c.req.query("limit")) || 50;

  // Admins/managers see all notifications for their restaurant; workers see only their own
  const memberIds = can(user, "TEAM_VIEW")
    ? listRestaurantMemberUserIds(restaurant.restaurantId, { includeInactiveUsers: true })
    : [];
  if (can(user, "TEAM_VIEW") && memberIds.length === 0) return c.json({ data: [] });
  const conditions = can(user, "TEAM_VIEW")
    ? [inArray(users.id, memberIds)]
    : [eq(notifications.recipientId, user.id)];

  const rows = db.select({
    id: notifications.id,
    recipientId: notifications.recipientId,
    recipientName: users.name,
    type: notifications.type,
    channel: notifications.channel,
    message: notifications.message,
    status: notifications.status,
    scheduledFor: notifications.scheduledFor,
    sentAt: notifications.sentAt,
    createdAt: notifications.createdAt,
  })
    .from(notifications)
    .innerJoin(users, eq(notifications.recipientId, users.id))
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();

  return c.json({ data: rows });
});

// POST /notifications/process — flush the queue (admin only)
notificationRoutes.post("/process", requireAdmin, async (c) => {
  const result = await processQueue();
  return c.json({ data: result });
});

// POST /notifications/:id/retry — retry a failed notification (admin only)
notificationRoutes.post("/:id/retry", requireAdmin, async (c) => {
  const id = c.req.param("id");

  const restaurant = requestRestaurant(c);

  const memberIds = listRestaurantMemberUserIds(restaurant.restaurantId, { includeInactiveUsers: true });
  if (memberIds.length === 0) return c.json({ error: "Not found" }, 404);

  const [notif] = db.select({ id: notifications.id, status: notifications.status })
    .from(notifications)
    .innerJoin(users, eq(notifications.recipientId, users.id))
    .where(and(eq(notifications.id, id), inArray(users.id, memberIds)))
    .limit(1)
    .all();

  if (!notif) return c.json({ error: "Not found" }, 404);
  if (notif.status !== "failed") return c.json({ error: "Only failed notifications can be retried" }, 400);

  // Re-queue
  db.update(notifications).set({ status: "queued" }).where(eq(notifications.id, id)).run();

  const result = await processQueue();
  return c.json({ data: { retried: true, ...result } });
});
