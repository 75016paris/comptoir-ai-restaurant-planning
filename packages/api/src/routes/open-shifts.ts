/**
 * POST /open-shifts — admin posts a vacant slot. Eligible workers are computed via
 * rankReplacementCandidates and broadcast to via WhatsApp; first to reply "je prends"
 * (claim_open_shift bot tool) gets the slot.
 *
 * Web dashboard creation UI is separate from this endpoint — admin-callable directly today.
 */
import { Hono } from "hono";
import { requireAuth, requirePermission, requireActiveSubscription, type AppEnv } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { createOpenShift } from "../services/open-shifts.js";
import { notifyOpenShiftBroadcast } from "../services/notifications.js";
import { logAudit } from "../db/audit.js";
import { db } from "../db/connection.js";
import { openShifts } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { timeHHMMSchema } from "@comptoir/shared";
import { isWeekLocked, WEEK_LOCKED_ERROR } from "../utils/week-lock.js";

export const openShiftRoutes = new Hono<AppEnv>();

openShiftRoutes.use("*", requireAuth);
openShiftRoutes.use("*", requireActiveSubscription);

openShiftRoutes.post("/", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();

  const { date, startTime, endTime, role, requiredSubRoles, message } = body ?? {};

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Date invalide (YYYY-MM-DD attendu)" }, 400);
  }
  if (typeof startTime !== "string" || !timeHHMMSchema.safeParse(startTime).success) {
    return c.json({ error: "Heure de début invalide (HH:MM attendu)" }, 400);
  }
  if (typeof endTime !== "string" || !timeHHMMSchema.safeParse(endTime).success) {
    return c.json({ error: "Heure de fin invalide (HH:MM attendu)" }, 400);
  }
  if (role !== "kitchen" && role !== "floor") {
    return c.json({ error: "Rôle invalide (kitchen ou floor)" }, 400);
  }
  const subRoles = Array.isArray(requiredSubRoles)
    ? requiredSubRoles.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  if (isWeekLocked(restaurant.restaurantId, date)) {
    return c.json({ error: WEEK_LOCKED_ERROR }, 423);
  }

  const cleanedMessage = typeof message === "string" && message.trim() ? message.trim() : null;
  const result = createOpenShift({
    restaurantId: restaurant.restaurantId,
    createdBy: user.id,
    date,
    startTime,
    endTime,
    role,
    requiredSubRoles: subRoles,
    message: cleanedMessage,
  });

  if (result.candidateIds.length > 0) {
    notifyOpenShiftBroadcast(result.id)
      .catch((err) => console.error("[open-shifts] solicitation failed:", err));
  }

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "open_shifts",
    rowId: result.id,
    action: "insert",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: `Service ouvert posté : ${role} ${date} ${startTime}-${endTime} → ${result.candidateIds.length} candidat${result.candidateIds.length === 1 ? "" : "s"}`,
  });

  return c.json({ data: { id: result.id, candidateCount: result.candidateIds.length } });
});

openShiftRoutes.post("/:id/cancel", requirePermission("PLANNING_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  const updated = db
    .update(openShifts)
    .set({ status: "cancelled" })
    .where(and(eq(openShifts.id, id), eq(openShifts.restaurantId, restaurant.restaurantId), eq(openShifts.status, "open")))
    .returning({ id: openShifts.id })
    .all();

  if (updated.length !== 1) return c.json({ error: "Service ouvert introuvable ou déjà clôturé" }, 404);

  logAudit({
    restaurantId: restaurant.restaurantId,
    tableName: "open_shifts",
    rowId: id,
    action: "update",
    actorId: user.id,
    actorName: user.name,
    source: "dashboard",
    summary: "Service ouvert annulé",
  });

  return c.json({ data: { ok: true } });
});

openShiftRoutes.get("/", requirePermission("PLANNING_EDIT"), async (c) => {
  const restaurant = requestRestaurant(c);
  const rows = db.select().from(openShifts)
    .where(eq(openShifts.restaurantId, restaurant.restaurantId))
    .all();
  return c.json({ data: rows });
});
