import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { SQLQueryBindings } from "bun:sqlite";
import { logAudit } from "../db/audit.js";
import { db, rawDb } from "../db/connection.js";
import { ownerMemberships, owners, restaurantMemberships, restaurants, users, workerRestaurantProfiles, workerShareAuthorizations } from "../db/schema.js";
import { type AppEnv, requireAuth } from "../middleware/auth.js";
import { columnExists } from "../services/restaurant-context.js";
import {
  acceptWorkerShareAuthorization,
  createWorkerShareAuthorization,
  declineWorkerShareAuthorization,
  listWorkerShareAuthorizations,
  revokeWorkerShareAuthorization,
  WorkerShareAuthorizationError,
} from "../services/worker-sharing.js";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";

export const restaurantRoutes = new Hono<AppEnv>();

restaurantRoutes.use("*", requireAuth);

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isOwnerAdmin(userId: string, ownerId: string): boolean {
  const row = db.select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(eq(ownerMemberships.ownerId, ownerId), eq(ownerMemberships.userId, userId)))
    .limit(1)
    .get();
  return row?.role === "owner_admin";
}

function isOwnerManagerOrAdmin(userId: string, ownerId: string): boolean {
  const row = db.select({ role: ownerMemberships.role })
    .from(ownerMemberships)
    .where(and(eq(ownerMemberships.ownerId, ownerId), eq(ownerMemberships.userId, userId)))
    .limit(1)
    .get();
  return row?.role === "owner_admin" || row?.role === "owner_manager";
}

function workerShareErrorStatus(code: string): 400 | 403 | 404 | 409 {
  if (code === "inviter_not_allowed" || code === "revoker_not_allowed") return 403;
  if (code === "restaurant_not_found" || code === "authorization_not_found" || code === "authorization_not_pending") return 404;
  if (code === "source_membership_required" || code === "target_membership_exists" || code === "worker_opt_in_required") return 409;
  return 400;
}

function insertRestaurantForCurrentSchema(input: {
  ownerId: string;
  name: string;
  address: string | null;
  timezone: string;
  status: string;
  subscriptionStatus: string;
}) {
  const id = crypto.randomUUID();
  const columns = ["id", "name", "address", "timezone", "status"];
  const values: SQLQueryBindings[] = [id, input.name, input.address, input.timezone, input.status];
  const optional: Array<[string, SQLQueryBindings]> = [
    ["owner_id", input.ownerId],
    ["subscription_status", input.subscriptionStatus],
    ["onboarding_completed_at", null],
    ["auto_staffing_weeks", 3],
    ["preferred_style", "equipe-stable"],
    ["default_contract_type", DEFAULT_CONTRACT_TYPE],
    ["default_contract_hours", DEFAULT_CONTRACT_HOURS],
  ];
  for (const [column, value] of optional) {
    if (columnExists("restaurants", column)) {
      columns.push(column);
      values.push(value);
    }
  }
  rawDb.prepare(`
    INSERT INTO restaurants (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...values);

  const onboardingExpression = columnExists("restaurants", "onboarding_completed_at")
    ? "onboarding_completed_at AS onboardingCompletedAt"
    : "NULL AS onboardingCompletedAt";
  const ownerExpression = columnExists("restaurants", "owner_id") ? "owner_id AS ownerId" : "id AS ownerId";
  return rawDb.query(`
    SELECT id, ${ownerExpression}, name, address, timezone, status, ${onboardingExpression}
    FROM restaurants
    WHERE id = ?
  `).get(id) as {
    id: string;
    ownerId: string | null;
    name: string;
    address: string | null;
    timezone: string;
    status: string;
    onboardingCompletedAt: string | null;
  };
}

// POST /restaurants — create a restaurant under the current owner account.
restaurantRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (!isOwnerAdmin(user.id, user.ownerId)) {
    return c.json({ error: "Forbidden — owner admin only" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = cleanText(body.name);
  if (!name) return c.json({ error: "name_required" }, 400);
  if (name.length > 120) return c.json({ error: "name_too_long" }, 400);

  const timezone = cleanText(body.timezone) || user.restaurantTimezone || "Europe/Paris";
  const address = cleanText(body.address) || null;
  const owner = db.select({ subscriptionStatus: owners.subscriptionStatus })
    .from(owners)
    .where(eq(owners.id, user.ownerId))
    .limit(1)
    .get();

  const restaurant = insertRestaurantForCurrentSchema({
    ownerId: user.ownerId,
    name,
    address,
    timezone,
    status: user.restaurantStatus === "demo" ? "demo" : "active",
    subscriptionStatus: owner?.subscriptionStatus ?? "active",
  });

  db.insert(restaurantMemberships).values({
    restaurantId: restaurant.id,
    userId: user.id,
    role: "admin",
    permissions: null,
    active: true,
  }).onConflictDoNothing().run();

  return c.json({ data: restaurant }, 201);
});

// PATCH /restaurants/:id — basic profile fields for an owned restaurant.
restaurantRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!isOwnerAdmin(user.id, user.ownerId)) {
    return c.json({ error: "Forbidden — owner admin only" }, 403);
  }

  const id = c.req.param("id");
  const existing = db.select({ id: restaurants.id })
    .from(restaurants)
    .where(and(eq(restaurants.id, id), eq(restaurants.ownerId, user.ownerId)))
    .limit(1)
    .get();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const updates: Partial<typeof restaurants.$inferInsert> = {};
  if (typeof body.name === "string") {
    const name = cleanText(body.name);
    if (!name) return c.json({ error: "name_required" }, 400);
    if (name.length > 120) return c.json({ error: "name_too_long" }, 400);
    updates.name = name;
  }
  if (typeof body.address === "string" || body.address === null) {
    updates.address = cleanText(body.address) || null;
  }
  if (typeof body.timezone === "string") {
    const timezone = cleanText(body.timezone);
    if (timezone) updates.timezone = timezone;
  }

  if (Object.keys(updates).length === 0) {
    const row = db.select().from(restaurants).where(eq(restaurants.id, id)).limit(1).get();
    return c.json({ data: row });
  }

  const row = db.update(restaurants)
    .set(updates)
    .where(and(eq(restaurants.id, id), eq(restaurants.ownerId, user.ownerId)))
    .returning()
    .get();
  return c.json({ data: row });
});

// GET /restaurants/:id/shareable-workers — scheduling identity from a same-owner source restaurant.
restaurantRoutes.get("/:id/shareable-workers", async (c) => {
  const user = c.get("user");
  const targetRestaurantId = c.req.param("id");
  const sourceRestaurantId = cleanText(c.req.query("sourceRestaurantId"));
  const role = cleanText(c.req.query("role"));
  if (!sourceRestaurantId) return c.json({ error: "source_restaurant_required" }, 400);
  if (role && role !== "kitchen" && role !== "floor") return c.json({ error: "invalid_role" }, 400);
  if (!isOwnerManagerOrAdmin(user.id, user.ownerId)) {
    return c.json({ error: "owner_manager_required" }, 403);
  }

  const [target, source] = await Promise.all([
    Promise.resolve(db.select({ id: restaurants.id, ownerId: restaurants.ownerId })
      .from(restaurants)
      .where(and(eq(restaurants.id, targetRestaurantId), eq(restaurants.ownerId, user.ownerId)))
      .limit(1)
      .get()),
    Promise.resolve(db.select({ id: restaurants.id, ownerId: restaurants.ownerId, name: restaurants.name })
      .from(restaurants)
      .where(and(eq(restaurants.id, sourceRestaurantId), eq(restaurants.ownerId, user.ownerId)))
      .limit(1)
      .get()),
  ]);
  if (!target || !source) return c.json({ error: "restaurant_not_found" }, 404);
  if (source.id === target.id) return c.json({ error: "same_restaurant" }, 400);

  const where = role
    ? and(
      eq(restaurantMemberships.restaurantId, sourceRestaurantId),
      eq(restaurantMemberships.active, true),
      eq(restaurantMemberships.role, role as "kitchen" | "floor"),
      eq(users.active, true),
    )
    : and(
      eq(restaurantMemberships.restaurantId, sourceRestaurantId),
      eq(restaurantMemberships.active, true),
      eq(users.active, true),
    );

  const targetMemberIds = new Set(db.select({ userId: restaurantMemberships.userId })
    .from(restaurantMemberships)
    .where(and(eq(restaurantMemberships.restaurantId, targetRestaurantId), eq(restaurantMemberships.active, true)))
    .all()
    .map((row) => row.userId));
  const alreadyShared = new Set(listWorkerShareAuthorizations({ ownerId: user.ownerId, targetRestaurantId })
    .filter((row) => row.status !== "revoked")
    .map((row) => `${row.userId}:${row.role}`));

  const rows = db.select({
    id: users.id,
    name: users.name,
    role: restaurantMemberships.role,
  })
    .from(restaurantMemberships)
    .innerJoin(users, eq(users.id, restaurantMemberships.userId))
    .innerJoin(ownerMemberships, and(
      eq(ownerMemberships.ownerId, user.ownerId),
      eq(ownerMemberships.userId, users.id),
    ))
    .where(where)
    .orderBy(users.name)
    .all()
    .filter((row) => row.role === "kitchen" || row.role === "floor")
    .filter((row) => !targetMemberIds.has(row.id))
    .filter((row) => !alreadyShared.has(`${row.id}:${row.role}`))
    .map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      sourceRestaurantId: source.id,
      sourceRestaurantName: source.name,
    }));

  return c.json({ data: rows });
});

// GET /restaurants/:id/worker-shares — scheduling-identity list for a target restaurant.
restaurantRoutes.get("/:id/worker-shares", async (c) => {
  const user = c.get("user");
  const targetRestaurantId = c.req.param("id");
  if (!isOwnerManagerOrAdmin(user.id, user.ownerId)) {
    return c.json({ error: "owner_manager_required" }, 403);
  }

  const target = db.select({ id: restaurants.id })
    .from(restaurants)
    .where(and(eq(restaurants.id, targetRestaurantId), eq(restaurants.ownerId, user.ownerId)))
    .limit(1)
    .get();
  if (!target) return c.json({ error: "restaurant_not_found" }, 404);

  const rows = listWorkerShareAuthorizations({ ownerId: user.ownerId, targetRestaurantId });
  return c.json({ data: rows });
});

// POST /restaurants/:id/worker-shares — authorize a same-owner worker into this restaurant's scheduling pool.
restaurantRoutes.post("/:id/worker-shares", async (c) => {
  const user = c.get("user");
  const targetRestaurantId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const sourceRestaurantId = cleanText(body.sourceRestaurantId);
  const userId = cleanText(body.userId);
  const role = cleanText(body.role);
  if (!sourceRestaurantId || !userId || (role !== "kitchen" && role !== "floor")) {
    return c.json({ error: "invalid_worker_share_payload" }, 400);
  }

  try {
    const previous = db
      .select({
        id: workerShareAuthorizations.id,
        sourceRestaurantId: workerShareAuthorizations.sourceRestaurantId,
        status: workerShareAuthorizations.status,
      })
      .from(workerShareAuthorizations)
      .where(and(
        eq(workerShareAuthorizations.ownerId, user.ownerId),
        eq(workerShareAuthorizations.targetRestaurantId, targetRestaurantId),
        eq(workerShareAuthorizations.userId, userId),
        eq(workerShareAuthorizations.role, role),
      ))
      .get();
    const row = createWorkerShareAuthorization({
      ownerId: user.ownerId,
      sourceRestaurantId,
      targetRestaurantId,
      userId,
      role,
      invitedByUserId: user.id,
      autoAccept: true,
    });
    if (previous && previous.status !== "revoked" && previous.sourceRestaurantId === row.sourceRestaurantId && previous.status === row.status) {
      return c.json({ data: row });
    }
    logAudit({
      restaurantId: row.targetRestaurantId,
      tableName: "worker_share_authorizations",
      rowId: row.id,
      action: previous ? "update" : "insert",
      actorId: user.id,
      actorName: user.name,
      source: "dashboard",
      changes: {
        sourceRestaurantId: { new: row.sourceRestaurantId },
        targetRestaurantId: { new: row.targetRestaurantId },
        userId: { new: row.userId },
        role: { new: row.role },
        status: { old: previous?.status, new: row.status },
      },
      summary: previous
        ? `Worker share re-authorized: ${row.userId} from ${row.sourceRestaurantId} to ${row.targetRestaurantId}`
        : `Worker share authorized: ${row.userId} from ${row.sourceRestaurantId} to ${row.targetRestaurantId}`,
    });
    return c.json({ data: row }, 201);
  } catch (err) {
    if (err instanceof WorkerShareAuthorizationError) {
      return c.json({ error: err.code }, workerShareErrorStatus(err.code));
    }
    throw err;
  }
});

// GET /restaurants/worker-shares/pending — worker's own pending share invitations.
restaurantRoutes.get("/worker-shares/pending", async (c) => {
  const user = c.get("user");
  const rows = listWorkerShareAuthorizations({ ownerId: user.ownerId, userId: user.id, actionableOnly: true })
    .filter((row) => row.status === "pending");
  return c.json({ data: rows });
});

// POST /restaurants/worker-shares/:authorizationId/accept — worker consent for a pending share.
restaurantRoutes.post("/worker-shares/:authorizationId/accept", async (c) => {
  const user = c.get("user");
  const authorizationId = c.req.param("authorizationId");
  try {
    const row = acceptWorkerShareAuthorization({ authorizationId, userId: user.id, ownerId: user.ownerId });
    logAudit({
      restaurantId: row.targetRestaurantId,
      tableName: "worker_share_authorizations",
      rowId: row.id,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source: "dashboard",
      changes: { status: { old: "pending", new: "accepted" } },
      summary: `Worker share accepted: ${row.userId} to ${row.targetRestaurantId}`,
    });
    return c.json({ data: row });
  } catch (err) {
    if (err instanceof WorkerShareAuthorizationError) {
      return c.json({ error: err.code }, workerShareErrorStatus(err.code));
    }
    throw err;
  }
});

// POST /restaurants/worker-shares/:authorizationId/decline — worker rejects a pending share.
restaurantRoutes.post("/worker-shares/:authorizationId/decline", async (c) => {
  const user = c.get("user");
  const authorizationId = c.req.param("authorizationId");
  try {
    const row = declineWorkerShareAuthorization({ authorizationId, userId: user.id, ownerId: user.ownerId });
    logAudit({
      restaurantId: row.targetRestaurantId,
      tableName: "worker_share_authorizations",
      rowId: row.id,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source: "dashboard",
      changes: { status: { old: "pending", new: "revoked" } },
      summary: `Worker share declined: ${row.userId} to ${row.targetRestaurantId}`,
    });
    return c.json({ data: row });
  } catch (err) {
    if (err instanceof WorkerShareAuthorizationError) {
      return c.json({ error: err.code }, workerShareErrorStatus(err.code));
    }
    throw err;
  }
});

// POST /restaurants/worker-shares/:authorizationId/revoke — owner revokes a pending/accepted share.
restaurantRoutes.post("/worker-shares/:authorizationId/revoke", async (c) => {
  const user = c.get("user");
  const authorizationId = c.req.param("authorizationId");
  const previous = db
    .select({ status: workerShareAuthorizations.status })
    .from(workerShareAuthorizations)
    .where(and(
      eq(workerShareAuthorizations.id, authorizationId),
      eq(workerShareAuthorizations.ownerId, user.ownerId),
    ))
    .get();
  try {
    const row = revokeWorkerShareAuthorization({
      authorizationId,
      ownerId: user.ownerId,
      actorUserId: user.id,
    });
    if (previous?.status === "revoked") {
      return c.json({ data: row });
    }
    logAudit({
      restaurantId: row.targetRestaurantId,
      tableName: "worker_share_authorizations",
      rowId: row.id,
      action: "update",
      actorId: user.id,
      actorName: user.name,
      source: "dashboard",
      changes: { status: { old: previous?.status ?? null, new: "revoked" } },
      summary: `Worker share revoked: ${row.userId} to ${row.targetRestaurantId}`,
    });
    return c.json({ data: row });
  } catch (err) {
    if (err instanceof WorkerShareAuthorizationError) {
      return c.json({ error: err.code }, workerShareErrorStatus(err.code));
    }
    throw err;
  }
});
