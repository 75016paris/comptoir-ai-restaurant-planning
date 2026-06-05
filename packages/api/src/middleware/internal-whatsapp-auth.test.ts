import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";
import type { AppEnv } from "./auth.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { loadInternalWhatsappUser, requireInternalWhatsappAuth } = await import("./internal-whatsapp-auth.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS whatsapp_context_sessions;
  DROP TABLE IF EXISTS worker_share_authorizations;
  DROP TABLE IF EXISTS worker_restaurant_profiles;
  DROP TABLE IF EXISTS restaurant_memberships;
  DROP TABLE IF EXISTS owner_memberships;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  DROP TABLE IF EXISTS owners;
  PRAGMA foreign_keys = ON;

  CREATE TABLE owners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE restaurants (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL,
    subscription_status TEXT NOT NULL
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    permissions TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE owner_memberships (
    owner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (owner_id, user_id)
  );
  CREATE TABLE restaurant_memberships (
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    permissions TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (restaurant_id, user_id)
  );
  CREATE TABLE worker_restaurant_profiles (
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    contract_hours INTEGER,
    multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (restaurant_id, user_id)
  );
  CREATE TABLE worker_share_authorizations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    source_restaurant_id TEXT NOT NULL,
    target_restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    invited_by_user_id TEXT NOT NULL,
    worker_consented_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE whatsapp_context_sessions (
    phone TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    selected_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

const app = new Hono<AppEnv>();
app.use("*", requireInternalWhatsappAuth);
app.get("/internal/whatsapp/me", (c) => {
  const user = c.get("user");
  return c.json({ data: { id: user.id, role: user.role, restaurantId: user.restaurantId, permissions: user.permissions } });
});

function insertRestaurant(id: string, status = "active", subscriptionStatus = "active") {
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, "owner-1", `Restaurant ${id}`, "Europe/Paris", status, subscriptionStatus,
  );
}

function insertUser(input: {
  id: string;
  restaurantId: string;
  role?: string;
  active?: boolean;
  mustChangePassword?: boolean;
  permissions?: string | null;
}) {
  rawDb.prepare(`
    INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `User ${input.id}`,
    `${input.id}@example.com`,
    `+336${input.id}`,
    input.role ?? "floor",
    input.restaurantId,
    input.active === false ? 0 : 1,
    input.permissions ?? null,
    input.mustChangePassword ? 1 : 0,
  );
}

function addMembership(userId: string, restaurantId: string, role = "manager", permissions: string | null = null) {
  rawDb.prepare("INSERT OR IGNORE INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-1", userId, role === "admin" ? "owner_admin" : "member");
  rawDb.prepare("INSERT OR REPLACE INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, 1)")
    .run(restaurantId, userId, role, permissions);
}

function headers(secret = "test-secret", userId = "active-user") {
  return {
    "X-WhatsApp-Internal-Secret": secret,
    "X-Comptoir-User-Id": userId,
  };
}

function addAcceptedShare(userId: string, sourceRestaurantId: string, targetRestaurantId: string, role = "floor") {
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, multi_restaurant_willing)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(targetRestaurantId, userId, 1, "[]", 35, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `share-${userId}-${targetRestaurantId}`,
    "owner-1",
    sourceRestaurantId,
    targetRestaurantId,
    userId,
    role,
    "accepted",
    "active-user",
    "2099-01-01T00:00:00.000Z",
    null,
  );
}

beforeEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.APP_ENV;
  delete process.env.ENVIRONMENT;
  delete process.env.FRONTEND_URL;
  process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";

  resetSqliteTables(rawDb);
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-1", "Owner 1");
  insertRestaurant("resto-active", "active", "active");
  insertRestaurant("resto-alt", "active", "active");
  insertRestaurant("resto-blocked", "active", "unpaid");
  insertRestaurant("resto-demo", "demo", "unpaid");
  insertUser({ id: "active-user", restaurantId: "resto-active", role: "manager", permissions: JSON.stringify({ HOURS_VIEW: false }) });
  insertUser({ id: "inactive-user", restaurantId: "resto-active", active: false });
  insertUser({ id: "blocked-user", restaurantId: "resto-blocked" });
  insertUser({ id: "demo-user", restaurantId: "resto-demo" });
  insertUser({ id: "password-user", restaurantId: "resto-active", mustChangePassword: true });
  addMembership("active-user", "resto-active", "manager", JSON.stringify({ HOURS_VIEW: false }));
  addMembership("inactive-user", "resto-active");
  addMembership("blocked-user", "resto-blocked");
  addMembership("demo-user", "resto-demo");
  addMembership("password-user", "resto-active");
});

describe("requireInternalWhatsappAuth", () => {
  test("missing configured secret rejects", async () => {
    delete process.env.WHATSAPP_INTERNAL_API_SECRET;

    const res = await app.request("/internal/whatsapp/me", { headers: headers() });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Internal WhatsApp API is not configured" });
  });

  test("invalid secret rejects", async () => {
    const res = await app.request("/internal/whatsapp/me", { headers: headers("wrong") });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  test("valid secret and active user succeeds", async () => {
    const res = await app.request("/internal/whatsapp/me", { headers: headers() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: "active-user",
        role: "manager",
        restaurantId: "resto-active",
        permissions: JSON.stringify({ HOURS_VIEW: false }),
      },
    });
  });

  test("uses pinned WhatsApp restaurant context when no explicit restaurant header is sent", async () => {
    addMembership("active-user", "resto-alt", "admin", JSON.stringify({ PLANNING_EDIT: true }));
    rawDb.prepare(`
      INSERT INTO whatsapp_context_sessions (phone, user_id, restaurant_id, selected_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("+336active-user", "active-user", "resto-alt", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

    const res = await app.request("/internal/whatsapp/me", { headers: headers() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: "active-user",
        role: "admin",
        restaurantId: "resto-alt",
        permissions: JSON.stringify({ PLANNING_EDIT: true }),
      },
    });
  });

  test("explicit restaurant header overrides pinned WhatsApp context after validation", async () => {
    addMembership("active-user", "resto-alt", "admin", JSON.stringify({ PLANNING_EDIT: true }));
    rawDb.prepare(`
      INSERT INTO whatsapp_context_sessions (phone, user_id, restaurant_id, selected_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("+336active-user", "active-user", "resto-alt", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers(),
        "X-Comptoir-Restaurant-Id": "resto-active",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: "active-user",
        role: "manager",
        restaurantId: "resto-active",
        permissions: JSON.stringify({ HOURS_VIEW: false }),
      },
    });
  });

  test("explicit restaurant header can resolve an accepted shared-worker target context", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: "shared-user",
        role: "floor",
        restaurantId: "resto-alt",
        permissions: "{}",
      },
    });
  });

  test("pinned WhatsApp restaurant context can resolve an accepted shared-worker target context", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare(`
      INSERT INTO whatsapp_context_sessions (phone, user_id, restaurant_id, selected_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("+336shared-user", "shared-user", "resto-alt", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

    const res = await app.request("/internal/whatsapp/me", {
      headers: headers("test-secret", "shared-user"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: "shared-user",
        role: "floor",
        restaurantId: "resto-alt",
        permissions: "{}",
      },
    });
  });

  test("shared-worker target context does not inherit source-row permissions", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor", permissions: JSON.stringify({ PLANNING_EDIT: true }) });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: "shared-user",
        role: "floor",
        restaurantId: "resto-alt",
        permissions: "{}",
      },
    });
  });

  test("shared-worker target context does not inherit source owner role", () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare("UPDATE owner_memberships SET role = ? WHERE owner_id = ? AND user_id = ?")
      .run("owner_admin", "owner-1", "shared-user");

    const result = loadInternalWhatsappUser("shared-user", "resto-alt");

    expect(result).toMatchObject({
      ok: true,
      user: {
        id: "shared-user",
        role: "floor",
        ownerRole: "member",
        restaurantId: "resto-alt",
        permissions: "{}",
      },
    });
  });

  test("shared-worker target context enforces target restaurant subscription status", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare("UPDATE restaurants SET subscription_status = ? WHERE id = ?")
      .run("unpaid", "resto-alt");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Abonnement inactif", subscriptionStatus: "unpaid" });
  });

  test("revoked shared-worker target context is rejected", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2099-01-02T00:00:00.000Z", "share-shared-user-resto-alt");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Restaurant inaccessible", code: "RESTAURANT_CONTEXT_FORBIDDEN" });
  });

  test("shared-worker target context is rejected after source membership is inactive", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("resto-source", "shared-user");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Restaurant inaccessible", code: "RESTAURANT_CONTEXT_FORBIDDEN" });
  });

  test("shared-worker target context is rejected after target restaurant leaves the authorization owner", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-2", "resto-alt");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Restaurant inaccessible", code: "RESTAURANT_CONTEXT_FORBIDDEN" });
  });

  test("shared-worker target context is rejected after worker leaves the owner account", async () => {
    insertRestaurant("resto-source", "active", "active");
    insertUser({ id: "shared-user", restaurantId: "resto-source", role: "floor" });
    addMembership("shared-user", "resto-source", "floor");
    addAcceptedShare("shared-user", "resto-source", "resto-alt", "floor");
    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-1", "shared-user");

    const res = await app.request("/internal/whatsapp/me", {
      headers: {
        ...headers("test-secret", "shared-user"),
        "X-Comptoir-Restaurant-Id": "resto-alt",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Restaurant inaccessible", code: "RESTAURANT_CONTEXT_FORBIDDEN" });
  });

  test("inactive user rejects", async () => {
    const res = await app.request("/internal/whatsapp/me", { headers: headers("test-secret", "inactive-user") });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Ce compte a été désactivé" });
  });

  test("blocked subscription rejects", async () => {
    const res = await app.request("/internal/whatsapp/me", { headers: headers("test-secret", "blocked-user") });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Abonnement inactif", subscriptionStatus: "unpaid" });
  });

  test("demo restaurant bypasses blocked subscription", async () => {
    const res = await app.request("/internal/whatsapp/me", { headers: headers("test-secret", "demo-user") });

    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe("demo-user");
  });

  test("mustChangePassword user rejects", async () => {
    const res = await app.request("/internal/whatsapp/me", { headers: headers("test-secret", "password-user") });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Changement de mot de passe requis", code: "PASSWORD_CHANGE_REQUIRED" });
  });
});
