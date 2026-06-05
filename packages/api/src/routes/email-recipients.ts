import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { emailRecipients } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireAdmin, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";

export const emailRecipientRoutes = new Hono<AppEnv>();
emailRecipientRoutes.use("*", requireAuth);
emailRecipientRoutes.use("*", requireAdmin);
emailRecipientRoutes.use("*", requireActiveSubscription);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /email-recipients — list this restaurant's extra recipients
emailRecipientRoutes.get("/", (c) => {
  const restaurant = requestRestaurant(c);
  const rows = db.select()
    .from(emailRecipients)
    .where(eq(emailRecipients.restaurantId, restaurant.restaurantId))
    .orderBy(emailRecipients.createdAt)
    .all();
  return c.json(rows);
});

// POST /email-recipients — create
emailRecipientRoutes.post("/", async (c) => {
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!label) return c.json({ error: "label_required" }, 400);
  if (!EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);

  const row = db.insert(emailRecipients).values({
    restaurantId: restaurant.restaurantId,
    label,
    email,
    sendMonthlyDigest: !!body.sendMonthlyDigest,
    sendLeaveAlerts: !!body.sendLeaveAlerts,
  }).returning().get();

  return c.json(row, 201);
});

// PATCH /email-recipients/:id — update label, email, or toggles
emailRecipientRoutes.patch("/:id", async (c) => {
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.select().from(emailRecipients)
    .where(and(eq(emailRecipients.id, id), eq(emailRecipients.restaurantId, restaurant.restaurantId)))
    .get();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const updates: Partial<typeof emailRecipients.$inferInsert> = {};
  if (typeof body.label === "string") {
    const l = body.label.trim();
    if (!l) return c.json({ error: "label_required" }, 400);
    updates.label = l;
  }
  if (typeof body.email === "string") {
    const e = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return c.json({ error: "invalid_email" }, 400);
    updates.email = e;
  }
  if (typeof body.sendMonthlyDigest === "boolean") updates.sendMonthlyDigest = body.sendMonthlyDigest;
  if (typeof body.sendLeaveAlerts === "boolean") updates.sendLeaveAlerts = body.sendLeaveAlerts;

  if (Object.keys(updates).length === 0) return c.json(existing);

  const row = db.update(emailRecipients)
    .set(updates)
    .where(and(eq(emailRecipients.id, id), eq(emailRecipients.restaurantId, restaurant.restaurantId)))
    .returning()
    .get();

  return c.json(row);
});

// DELETE /email-recipients/:id
emailRecipientRoutes.delete("/:id", (c) => {
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const deleted = db.delete(emailRecipients)
    .where(and(eq(emailRecipients.id, id), eq(emailRecipients.restaurantId, restaurant.restaurantId)))
    .returning()
    .get();
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
