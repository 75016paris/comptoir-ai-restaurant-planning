import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { auditLogs } from "../db/schema.js";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { requireAuth, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.use("*", requireAuth);
auditRoutes.use("*", requireActiveSubscription);

// GET /audit-logs?from=...&to=...&tableName=...&actorId=...&action=...&limit=50&offset=0
auditRoutes.get("/", requirePermission("AUDIT_VIEW"), async (c) => {
  const restaurant = requestRestaurant(c);
  const from = c.req.query("from");
  const to = c.req.query("to");
  const tableName = c.req.query("tableName");
  const actorId = c.req.query("actorId");
  const action = c.req.query("action");
  const source = c.req.query("source");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const offset = Number(c.req.query("offset")) || 0;

  const conditions = [eq(auditLogs.restaurantId, restaurant.restaurantId)];
  if (from) conditions.push(gte(auditLogs.createdAt, from));
  if (to) conditions.push(lte(auditLogs.createdAt, to + "T23:59:59"));
  if (tableName) conditions.push(eq(auditLogs.tableName, tableName));
  if (actorId) conditions.push(eq(auditLogs.actorId, actorId));
  if (action) conditions.push(eq(auditLogs.action, action as "insert" | "update" | "delete"));
  if (source) conditions.push(eq(auditLogs.source, source));

  const rows = db
    .select({
      id: auditLogs.id,
      tableName: auditLogs.tableName,
      rowId: auditLogs.rowId,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      actorName: auditLogs.actorName,
      source: auditLogs.source,
      changes: auditLogs.changes,
      summary: auditLogs.summary,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  // Parse changes JSON
  const data = rows.map((r) => ({
    ...r,
    changes: r.changes ? JSON.parse(r.changes) : null,
  }));

  return c.json({ data });
});
