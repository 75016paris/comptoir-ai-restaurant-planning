import { createMiddleware } from "hono/factory";
import { db } from "../db/connection.js";
import { sessions, users, restaurants, owners } from "../db/schema.js";
import { eq, and, gt } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { can, type Permission } from "@comptoir/shared";
import { hasCurrentOwnerLegalAcceptance, hasCurrentUserNoticeAcceptance } from "../services/legal-acceptance.js";
import { listAccessibleRestaurants, resolveSessionRestaurantContext, type AccessibleRestaurant, type OwnerRole } from "../services/restaurant-context.js";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  ownerId: string;
  ownerRole: OwnerRole;
  activeRestaurantId: string;
  restaurantId: string;
  restaurantName?: string;
  restaurantStatus?: string;
  restaurantTimezone: string;
  permissions: string | null; // JSON-stringified Partial<Record<Permission, boolean>>
  restaurants?: AccessibleRestaurant[];
  mustChangePassword: boolean;
  userNoticeVersion?: string | null;
  userNoticeAcceptedAt?: string | null;
  whatsappOptIn?: boolean;
};

export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = db
    .select({
      userId: sessions.userId,
      name: users.name,
      email: users.email,
      role: users.role,
      restaurantId: users.restaurantId,
      active: users.active,
      permissions: users.permissions,
      mustChangePassword: users.mustChangePassword,
      userNoticeVersion: users.userNoticeVersion,
      userNoticeAcceptedAt: users.userNoticeAcceptedAt,
      whatsappOptIn: users.whatsappOptIn,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, new Date().toISOString())
      )
    )
    .limit(1)
    .all();

  if (result.length === 0) {
    return c.json({ error: "Session expired" }, 401);
  }

  // Deactivated users can't access anything
  if (result[0].active === false) {
    return c.json({ error: "Ce compte a été désactivé" }, 403);
  }

  const row = result[0];
  const restaurantContext = resolveSessionRestaurantContext(row.userId, row.restaurantId, sessionId);
  if (!restaurantContext) {
    return c.json({ error: "Restaurant not found" }, 404);
  }

  c.set("user", {
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
    restaurants: listAccessibleRestaurants(row.userId),
    mustChangePassword: row.mustChangePassword,
    userNoticeVersion: row.userNoticeVersion,
    userNoticeAcceptedAt: row.userNoticeAcceptedAt,
    whatsappOptIn: row.whatsappOptIn,
  });

  if (row.mustChangePassword) {
    const allowed = new Set([
      "/auth/me",
      "/auth/logout",
      "/users/me/password",
      "/api/auth/me",
      "/api/auth/logout",
      "/api/users/me/password",
      "/auth/restaurants",
      "/auth/active-restaurant",
      "/api/auth/restaurants",
      "/api/auth/active-restaurant",
    ]);
    if (!allowed.has(c.req.path)) {
      return c.json({ error: "Changement de mot de passe requis", code: "PASSWORD_CHANGE_REQUIRED" }, 403);
    }
    await next();
    return;
  }

  const activeLegalRow = {
    ...row,
    role: restaurantContext.role,
    ownerRole: restaurantContext.ownerRole,
    restaurantStatus: restaurantContext.status,
    restaurantId: restaurantContext.restaurantId,
  };

  const ownerLegalRequired = (restaurantContext.role === "admin" || restaurantContext.ownerRole === "owner_admin") && restaurantContext.status !== "demo";
  const userNoticeRequired = restaurantContext.role !== "admin" && restaurantContext.ownerRole !== "owner_admin" && restaurantContext.status !== "demo";

  if (userNoticeRequired && !hasCurrentUserNoticeAcceptance(activeLegalRow)) {
    const allowed = new Set([
      "/auth/me",
      "/auth/logout",
      "/auth/legal/accept-user-notice",
      "/auth/restaurants",
      "/auth/active-restaurant",
      "/api/auth/me",
      "/api/auth/logout",
      "/api/auth/legal/accept-user-notice",
      "/api/auth/restaurants",
      "/api/auth/active-restaurant",
    ]);
    if (!allowed.has(c.req.path)) {
      return c.json({ error: "Acceptation de la notice utilisateur requise", code: "USER_NOTICE_ACCEPTANCE_REQUIRED" }, 403);
    }
  }

  if (ownerLegalRequired && !hasCurrentOwnerLegalAcceptance(restaurantContext.restaurantId, restaurantContext.ownerId)) {
    const allowed = new Set([
      "/auth/me",
      "/auth/logout",
      "/auth/legal/accept-owner",
      "/auth/restaurants",
      "/auth/active-restaurant",
      "/api/auth/me",
      "/api/auth/logout",
      "/api/auth/legal/accept-owner",
      "/api/auth/restaurants",
      "/api/auth/active-restaurant",
    ]);
    if (!allowed.has(c.req.path)) {
      return c.json({ error: "Acceptation des conditions légales requise", code: "OWNER_LEGAL_ACCEPTANCE_REQUIRED" }, 403);
    }
  }

  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Forbidden — admin only" }, 403);
  }
  await next();
});

export const requireOwnerAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.ownerRole !== "owner_admin") {
    return c.json({ error: "Forbidden — owner admin only" }, 403);
  }
  await next();
});

// Allow either admins or managers — used on routes where the manager role can
// also act (planning edits, replacement / leave approvals, team viewing, etc.).
// For finer-grained gating use requirePermission with a specific Permission key.
export const requireAdminOrManager = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin" && user.role !== "manager") {
    return c.json({ error: "Forbidden — admin or manager only" }, 403);
  }
  await next();
});

// Gate by a specific Permission key. Resolves the user's effective permission
// (role default merged with users.permissions overrides) via the can() helper
// from packages/shared.
export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!can(user, permission)) {
      return c.json({ error: `Forbidden — missing permission: ${permission}` }, 403);
    }
    await next();
  });

// Block access when subscription is cancelled or unpaid
// past_due gets a grace period (Stripe retries for ~3 weeks)
export const requireActiveSubscription = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.path === "/users/me/password" || c.req.path === "/api/users/me/password") {
    await next();
    return;
  }

  const user = c.get("user");

  const [restaurant] = db
    .select({ subscriptionStatus: restaurants.subscriptionStatus, status: restaurants.status, ownerId: restaurants.ownerId })
    .from(restaurants)
    .where(eq(restaurants.id, user.activeRestaurantId))
    .limit(1)
    .all();

  if (!restaurant) {
    return c.json({ error: "Restaurant not found" }, 404);
  }

  // Demo restaurants bypass subscription check
  if (restaurant.status === "demo") {
    await next();
    return;
  }

  const blocked = ["cancelled", "unpaid"];
  let subscriptionStatus = restaurant.subscriptionStatus;
  if (restaurant.ownerId) {
    const [owner] = db
      .select({ subscriptionStatus: owners.subscriptionStatus })
      .from(owners)
      .where(eq(owners.id, restaurant.ownerId))
      .limit(1)
      .all();
    subscriptionStatus = owner?.subscriptionStatus ?? subscriptionStatus;
  }

  if (blocked.includes(subscriptionStatus)) {
    return c.json({
      error: "Abonnement inactif",
      subscriptionStatus,
    }, 403);
  }

  await next();
});
