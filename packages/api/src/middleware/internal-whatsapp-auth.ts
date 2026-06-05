import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db, rawDb } from "../db/connection.js";
import { restaurants, users } from "../db/schema.js";
import type { AppEnv, AuthUser } from "./auth.js";
import { resolveRestaurantContext, resolveSharedWorkerRestaurantContext } from "../services/restaurant-context.js";

const BLOCKED_SUBSCRIPTION_STATUSES = new Set(["cancelled", "unpaid"]);

export function isProductionLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (env.NODE_ENV || "").toLowerCase();
  const appEnv = (env.APP_ENV || env.ENVIRONMENT || "").toLowerCase();
  const frontendUrl = env.FRONTEND_URL || "";
  return nodeEnv === "production"
    || nodeEnv === "staging"
    || appEnv === "production"
    || appEnv === "staging"
    || frontendUrl === "https://comptoir.cosmobot.fr"
    || frontendUrl === "https://staging.comptoir.cosmobot.fr";
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

type InternalAuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 403 | 404; body: { error: string; code?: string; subscriptionStatus?: string } };

function tableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

function loadPinnedWhatsappRestaurant(userId: string, phone: string | null | undefined): string | null {
  if (!phone || !tableExists("whatsapp_context_sessions")) return null;
  const row = rawDb.query(`
    SELECT restaurant_id AS restaurantId
    FROM whatsapp_context_sessions
    WHERE phone = ? AND user_id = ? AND expires_at > ?
    LIMIT 1
  `).get(phone, userId, new Date().toISOString()) as { restaurantId: string } | null;
  return row?.restaurantId ?? null;
}

export function loadInternalWhatsappUser(userId: string, restaurantId?: string | null): InternalAuthResult {
  const [row] = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
      restaurantId: users.restaurantId,
      active: users.active,
      permissions: users.permissions,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();

  if (!row) {
    return { ok: false, status: 404, body: { error: "User not found" } };
  }

  if (row.active === false) {
    return { ok: false, status: 403, body: { error: "Ce compte a été désactivé" } };
  }

  if (row.mustChangePassword) {
    return {
      ok: false,
      status: 403,
      body: { error: "Changement de mot de passe requis", code: "PASSWORD_CHANGE_REQUIRED" },
    };
  }

  const pinnedRestaurantId = restaurantId ?? loadPinnedWhatsappRestaurant(row.userId, row.phone);
  const restaurantContext = resolveRestaurantContext(row.userId, pinnedRestaurantId ?? row.restaurantId)
    ?? (pinnedRestaurantId ? resolveSharedWorkerRestaurantContext(row.userId, pinnedRestaurantId) : null);
  if (!restaurantContext) {
    return { ok: false, status: 403, body: { error: "Restaurant inaccessible", code: "RESTAURANT_CONTEXT_FORBIDDEN" } };
  }

  const [activeRestaurant] = db.select({
    status: restaurants.status,
    subscriptionStatus: restaurants.subscriptionStatus,
  }).from(restaurants).where(eq(restaurants.id, restaurantContext.restaurantId)).limit(1).all();

  if (!activeRestaurant) {
    return { ok: false, status: 404, body: { error: "Restaurant not found" } };
  }

  if (activeRestaurant.status !== "demo" && BLOCKED_SUBSCRIPTION_STATUSES.has(activeRestaurant.subscriptionStatus)) {
    return {
      ok: false,
      status: 403,
      body: { error: "Abonnement inactif", subscriptionStatus: activeRestaurant.subscriptionStatus },
    };
  }

  return {
    ok: true,
    user: {
      id: row.userId,
      name: row.name,
      email: row.email,
      role: restaurantContext.role,
      ownerId: restaurantContext.ownerId,
      ownerRole: restaurantContext.ownerRole,
      activeRestaurantId: restaurantContext.restaurantId,
      restaurantId: restaurantContext.restaurantId,
      restaurantName: restaurantContext.name,
      restaurantStatus: restaurantContext.status,
      restaurantTimezone: restaurantContext.timezone,
      permissions: restaurantContext.permissions ?? row.permissions,
      mustChangePassword: row.mustChangePassword,
    },
  };
}

export const requireInternalWhatsappAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expectedSecret = process.env.WHATSAPP_INTERNAL_API_SECRET || "";
  if (!expectedSecret) {
    if (isProductionLikeEnv()) {
      console.error("[SECURITY] WHATSAPP_INTERNAL_API_SECRET missing in production/staging; rejecting internal WhatsApp API request.");
    }
    return c.json({ error: "Internal WhatsApp API is not configured" }, 503);
  }

  const providedSecret = c.req.header("X-WhatsApp-Internal-Secret") || "";
  if (!providedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const userId = c.req.header("X-Comptoir-User-Id") || "";
  if (!userId) {
    return c.json({ error: "Missing X-Comptoir-User-Id" }, 400);
  }

  const requestedRestaurantId = c.req.header("X-Comptoir-Restaurant-Id") || null;
  const result = loadInternalWhatsappUser(userId, requestedRestaurantId);
  if (!result.ok) {
    return c.json(result.body, result.status);
  }

  c.set("user", result.user);
  await next();
});
