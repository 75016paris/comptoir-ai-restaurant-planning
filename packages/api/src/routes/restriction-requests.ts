import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import { restrictionRequests, workerRestrictions, users } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { z } from "zod";
import { can, flattenZodError } from "@comptoir/shared";

export const restrictionRequestRoutes = new Hono<AppEnv>();
restrictionRequestRoutes.use("*", requireAuth);
restrictionRequestRoutes.use("*", requireActiveSubscription);

const restrictionSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
});

const createRequestSchema = z.object({
  kind: z.enum(["permanent", "temporary"]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  restrictions: z.array(restrictionSchema).max(50),
  note: z.string().max(500).nullable().optional(),
}).refine(
  (d) => d.kind === "permanent" || (!!d.effectiveFrom && !!d.effectiveUntil && d.effectiveFrom <= d.effectiveUntil),
  { message: "Temporary requests require effectiveFrom ≤ effectiveUntil." }
);

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  adminNote: z.string().max(500).nullable().optional(),
});

function parseRow(r: any) {
  return { ...r, restrictions: JSON.parse(r.restrictions || "[]") };
}

// GET / — admin: all requests in restaurant (pending first); worker: own requests
restrictionRequestRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const whereClause = can(user, "TEAM_EDIT")
    ? eq(restrictionRequests.restaurantId, restaurant.restaurantId)
    : and(eq(restrictionRequests.restaurantId, restaurant.restaurantId), eq(restrictionRequests.workerId, user.id));

  const rows = db.select().from(restrictionRequests)
    .where(whereClause)
    .orderBy(desc(restrictionRequests.createdAt))
    .all();

  // Enrich with worker name for admin view
  const workerNames = new Map<string, string>();
  if (can(user, "TEAM_EDIT")) {
    const uids = [...new Set(rows.map(r => r.workerId))];
    if (uids.length > 0) {
      const uRows = db.select({ id: users.id, name: users.name }).from(users).all();
      for (const u of uRows) workerNames.set(u.id, u.name);
    }
  }

  return c.json({
    data: rows.map(r => ({
      ...parseRow(r),
      workerName: workerNames.get(r.workerId) ?? null,
    })),
  });
});

// POST / — worker submits a new request (creates pending)
restrictionRequestRoutes.post("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (can(user, "TEAM_EDIT")) {
    return c.json({ error: "Les gérants modifient les disponibilités directement (PUT /users/:id/restrictions)." }, 403);
  }

  const body = await c.req.json();
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  const [created] = db.insert(restrictionRequests).values({
    workerId: user.id,
    restaurantId: restaurant.restaurantId,
    kind: parsed.data.kind,
    effectiveFrom: parsed.data.effectiveFrom ?? null,
    effectiveUntil: parsed.data.effectiveUntil ?? null,
    restrictions: JSON.stringify(parsed.data.restrictions),
    note: parsed.data.note ?? null,
  }).returning().all();

  return c.json({ data: parseRow(created) }, 201);
});

// PATCH /:id — admin approve/reject (or worker cancel own pending)
restrictionRequestRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json();

  const [existing] = db.select().from(restrictionRequests)
    .where(and(eq(restrictionRequests.id, id), eq(restrictionRequests.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!existing) return c.json({ error: "Demande introuvable" }, 404);

  // Worker can cancel own pending
  if (!can(user, "TEAM_EDIT")) {
    if (existing.workerId !== user.id) return c.json({ error: "Forbidden" }, 403);
    if (existing.status !== "pending") return c.json({ error: "Seules les demandes en attente peuvent être annulées" }, 400);
    if (body.action !== "cancel") return c.json({ error: "Action non autorisée" }, 403);
    const [updated] = db.update(restrictionRequests)
      .set({ status: "cancelled" })
      .where(eq(restrictionRequests.id, id))
      .returning().all();
    return c.json({ data: parseRow(updated) });
  }

  // Admin: approve or reject
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }
  if (existing.status !== "pending") {
    return c.json({ error: "Cette demande a déjà été traitée" }, 400);
  }

  const now = new Date().toISOString();
  const nextStatus: "approved" | "rejected" = parsed.data.action === "approve" ? "approved" : "rejected";

  // If approved, apply restrictions to worker_restrictions
  if (nextStatus === "approved") {
    const restrictions = JSON.parse(existing.restrictions || "[]") as Array<{ dayOfWeek: number; startTime?: string | null; endTime?: string | null; reason?: string | null }>;
    if (existing.kind === "permanent") {
      // Overwrite worker's permanent restrictions (effective_from/until stay null)
      db.delete(workerRestrictions)
        .where(and(
          eq(workerRestrictions.workerId, existing.workerId),
          eq(workerRestrictions.restaurantId, existing.restaurantId),
        ))
        .run();
      if (restrictions.length > 0) {
        db.insert(workerRestrictions).values(restrictions.map(r => ({
          workerId: existing.workerId,
          restaurantId: existing.restaurantId,
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
          reason: r.reason ?? null,
          effectiveFrom: null,
          effectiveUntil: null,
        }))).run();
      }
    } else {
      // Temporary: insert restrictions with the date window — do NOT touch permanent rows.
      if (restrictions.length > 0) {
        db.insert(workerRestrictions).values(restrictions.map(r => ({
          workerId: existing.workerId,
          restaurantId: existing.restaurantId,
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
          reason: r.reason ?? null,
          effectiveFrom: existing.effectiveFrom,
          effectiveUntil: existing.effectiveUntil,
        }))).run();
      }
    }
  }

  const [updated] = db.update(restrictionRequests)
    .set({
      status: nextStatus,
      adminNote: parsed.data.adminNote ?? null,
      reviewedBy: user.id,
      reviewedAt: now,
    })
    .where(eq(restrictionRequests.id, id))
    .returning().all();

  return c.json({ data: parseRow(updated) });
});
