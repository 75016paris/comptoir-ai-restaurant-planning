import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hash } from "argon2";
import type { AppEnv } from "../middleware/auth.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-auth-active-restaurant-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { authRoutes, billingAdminRecipientsForRestaurant } = await import("./auth.js");
const { requireAuth } = await import("../middleware/auth.js");
const { OWNER_LEGAL_VERSIONS, USER_NOTICE_VERSION } = await import("../services/legal-acceptance.js");

const app = new Hono<AppEnv>();
app.route("/auth", authRoutes);
app.use("/whoami", requireAuth);
app.get("/whoami", (c) => c.json({ data: c.get("user") }));

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS open_shifts;
    DROP TABLE IF EXISTS replacement_requests;
    DROP TABLE IF EXISTS time_clocks;
    DROP TABLE IF EXISTS published_weeks;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS legal_acceptances;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS restaurant_memberships;
    DROP TABLE IF EXISTS owner_memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;

    CREATE TABLE owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      user_notice_version TEXT,
      user_notice_accepted_at TEXT,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE legal_acceptances (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      acceptance_type TEXT NOT NULL,
      terms_version TEXT NOT NULL,
      dpa_version TEXT NOT NULL,
      privacy_version TEXT NOT NULL,
      subprocessors_version TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed'
    );
  `);
}

function acceptOwnerTerms(restaurantId: string) {
  rawDb.prepare(`
    INSERT INTO legal_acceptances (
      id, owner_id, restaurant_id, user_id, acceptance_type,
      terms_version, dpa_version, privacy_version, subprocessors_version
    ) VALUES (?, (SELECT owner_id FROM restaurants WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `legal-${restaurantId}`,
    restaurantId,
    restaurantId,
    "admin-a",
    "owner_terms",
    OWNER_LEGAL_VERSIONS.terms,
    OWNER_LEGAL_VERSIONS.dpa,
    OWNER_LEGAL_VERSIONS.privacy,
    OWNER_LEGAL_VERSIONS.subprocessors,
  );
}

beforeEach(() => {
  createSchema();
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");

  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, timezone, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "Europe/Paris", "active", "2026-05-01T00:00:00.000Z");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, timezone, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "Europe/Paris", "active", null);
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, timezone, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("b1", "owner-b", "Gamma", "Europe/Paris", "active", null);

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions,
      must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin-a@example.com", "+33600000001", "admin", "a1", 1, '{"settings":true}', 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions,
      must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-shared", "Shared Worker", "shared@example.com", "+33600000002", "floor", "a1", 1, null, 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions,
      must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-a2", "Beta Worker", "beta@example.com", "+33600000003", "kitchen", "a2", 1, null, 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions,
      must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-b", "Other Worker", "other@example.com", "+33600000004", "floor", "b1", 1, null, 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions,
      must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("billing-admin", "Billing Admin", "billing@example.com", "+33600000005", "admin", "a1", 1, null, 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", '{"settings":true}', 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "manager", '{"planning":true}', 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "billing-admin", "admin", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a1", future);

  acceptOwnerTerms("a1");
  acceptOwnerTerms("a2");

  const insertService = rawDb.prepare("INSERT INTO services (id, restaurant_id, worker_id, date, status) VALUES (?, ?, ?, ?, ?)");
  insertService.run("svc-a1-shared", "a1", "worker-shared", "2026-05-03", "confirmed");
  insertService.run("svc-a2-shared", "a2", "worker-shared", "2026-05-04", "confirmed");
  insertService.run("svc-a2-worker", "a2", "worker-a2", "2026-05-05", "confirmed");
  insertService.run("svc-b", "b1", "worker-b", "2026-05-06", "confirmed");
});

describe("active restaurant auth context", () => {
  test("login returns active membership context even when legacy users.restaurant_id differs", async () => {
    rawDb.prepare("UPDATE users SET restaurant_id = ?, password_hash = ? WHERE id = ?")
      .run("b1", await hash("correct horse battery staple"), "admin-a");

    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-a@example.com", password: "correct horse battery staple" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        id: "admin-a",
        ownerId: "owner-a",
        ownerRole: "owner_admin",
        restaurantId: "a1",
        activeRestaurantId: "a1",
        restaurantName: "Alpha",
      },
    });
  });

  test("demo login validates the active membership restaurant instead of stale legacy restaurant_id", async () => {
    rawDb.prepare("UPDATE restaurants SET status = ? WHERE id = ?").run("demo", "a1");
    rawDb.prepare("UPDATE users SET restaurant_id = ? WHERE id = ?").run("b1", "admin-a");

    const res = await app.request("/auth/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-a@example.com" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        id: "admin-a",
        ownerId: "owner-a",
        ownerRole: "owner_admin",
        restaurantId: "a1",
        activeRestaurantId: "a1",
        restaurantStatus: "demo",
      },
    });
  });

  test("lists only active restaurant memberships for the current user", async () => {
    const res = await app.request("/auth/restaurants", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        activeRestaurantId: "a1",
        restaurants: [
          {
            id: "a1",
            ownerId: "owner-a",
            name: "Alpha",
            status: "active",
            timezone: "Europe/Paris",
            onboardingCompletedAt: "2026-05-01T00:00:00.000Z",
            role: "admin",
            ownerRole: "owner_admin",
            permissions: '{"settings":true}',
            active: true,
          },
          {
            id: "a2",
            ownerId: "owner-a",
            name: "Beta",
            status: "active",
            timezone: "Europe/Paris",
            onboardingCompletedAt: null,
            role: "manager",
            ownerRole: "owner_admin",
            permissions: '{"planning":true}',
            active: true,
          },
        ],
      },
    });
  });

  test("switches to a restaurant where membership exists", async () => {
    const res = await app.request("/auth/active-restaurant", {
      method: "POST",
      headers: { cookie: "session=session-a" },
      body: JSON.stringify({ restaurantId: "a2" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.activeRestaurantId).toBe("a2");

    const session = rawDb.query("SELECT active_restaurant_id FROM sessions WHERE id = ?").get("session-a") as any;
    expect(session.active_restaurant_id).toBe("a2");
  });

  test("rejects sibling restaurants without membership and restaurants from another owner", async () => {
    rawDb.prepare("DELETE FROM restaurant_memberships WHERE restaurant_id = ? AND user_id = ?").run("a2", "admin-a");

    const sibling = await app.request("/auth/active-restaurant", {
      method: "POST",
      headers: { cookie: "session=session-a" },
      body: JSON.stringify({ restaurantId: "a2" }),
    });
    expect(sibling.status).toBe(403);

    const otherOwner = await app.request("/auth/active-restaurant", {
      method: "POST",
      headers: { cookie: "session=session-a" },
      body: JSON.stringify({ restaurantId: "b1" }),
    });
    expect(otherOwner.status).toBe(403);
  });

  test("/auth/me and requireAuth follow the active restaurant context", async () => {
    rawDb.prepare("UPDATE sessions SET active_restaurant_id = ? WHERE id = ?").run("a2", "session-a");

    const me = await app.request("/auth/me", {
      headers: { cookie: "session=session-a" },
    });
    expect(me.status).toBe(200);
    const meJson = await me.json();
    expect(meJson.data.restaurantId).toBe("a2");
    expect(meJson.data.activeRestaurantId).toBe("a2");
    expect(meJson.data.ownerId).toBe("owner-a");
    expect(meJson.data.role).toBe("manager");
    expect(meJson.data.ownerRole).toBe("owner_admin");
    expect(meJson.data.permissions).toBe('{"planning":true}');

    const whoami = await app.request("/whoami", {
      headers: { cookie: "session=session-a" },
    });
    expect(whoami.status).toBe(200);
    const whoamiJson = await whoami.json();
    expect(whoamiJson.data.restaurantId).toBe("a2");
    expect(whoamiJson.data.activeRestaurantId).toBe("a2");
    expect(whoamiJson.data.role).toBe("manager");
    expect(whoamiJson.data.ownerRole).toBe("owner_admin");
    expect(whoamiJson.data.permissions).toBe('{"planning":true}');
  });

  test("billing active employees are counted across the owner account", async () => {
    const res = await app.request("/auth/billing/active-employees?month=2026-05", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.activeCount).toBe(2);
    expect(json.data.workers.sort()).toEqual(["Beta Worker", "Shared Worker"]);
    expect(json.data.restaurants).toEqual([
      {
        restaurantId: "a1",
        restaurantName: "Alpha",
        activeCount: 1,
        workers: ["Shared Worker"],
      },
      {
        restaurantId: "a2",
        restaurantName: "Beta",
        activeCount: 2,
        workers: ["Shared Worker", "Beta Worker"],
      },
    ]);
  });

  test("owner admin can access owner billing while active restaurant role is manager", async () => {
    rawDb.prepare("UPDATE sessions SET active_restaurant_id = ? WHERE id = ?").run("a2", "session-a");

    const billing = await app.request("/auth/billing", {
      headers: { cookie: "session=session-a" },
    });
    expect(billing.status).toBe(200);
    expect(await billing.json()).toMatchObject({
      data: {
        subscriptionStatus: "active",
        status: "active",
      },
    });

    const activeEmployees = await app.request("/auth/billing/active-employees?month=2026-05", {
      headers: { cookie: "session=session-a" },
    });
    expect(activeEmployees.status).toBe(200);
    expect((await activeEmployees.json()).data.activeCount).toBe(2);
  });

  test("billing active employee preview rejects malformed months", async () => {
    const res = await app.request("/auth/billing/active-employees?month=2026-13", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Mois de facturation invalide. Format attendu: YYYY-MM." });
  });

  test("billing usage reporting rejects malformed months before Stripe work", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const res = await app.request("/auth/billing/report-usage", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ month: "2026-99" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Mois de facturation invalide. Format attendu: YYYY-MM." });
  });

  test("billing admin recipients use active restaurant membership instead of legacy users.restaurant_id", () => {
    expect(billingAdminRecipientsForRestaurant("a2")).toEqual([{ id: "billing-admin" }]);
  });

  test("owner legal acceptance is stored against the owner account", async () => {
    rawDb.prepare("DELETE FROM legal_acceptances").run();

    const res = await app.request("/auth/legal/accept-owner", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const row = rawDb.prepare(`
      SELECT owner_id AS ownerId, restaurant_id AS restaurantId
      FROM legal_acceptances
      WHERE acceptance_type = 'owner_terms'
    `).get() as { ownerId: string | null; restaurantId: string } | null;

    expect(row).toEqual({ ownerId: "owner-a", restaurantId: "a1" });
  });

  test("owner admin with local manager role must accept owner legal terms, not user notice", async () => {
    rawDb.prepare("DELETE FROM legal_acceptances").run();
    rawDb.prepare("UPDATE users SET user_notice_version = NULL, user_notice_accepted_at = NULL WHERE id = ?")
      .run("admin-a");
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("manager", "a2", "admin-a");
    rawDb.prepare("UPDATE sessions SET active_restaurant_id = ? WHERE id = ?").run("a2", "session-a");

    const res = await app.request("/whoami", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Acceptation des conditions légales requise",
      code: "OWNER_LEGAL_ACCEPTANCE_REQUIRED",
    });
  });

  test("owner admin with local manager role can accept owner legal terms", async () => {
    rawDb.prepare("DELETE FROM legal_acceptances").run();
    rawDb.prepare("UPDATE users SET user_notice_version = NULL, user_notice_accepted_at = NULL WHERE id = ?")
      .run("admin-a");
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("manager", "a2", "admin-a");
    rawDb.prepare("UPDATE sessions SET active_restaurant_id = ? WHERE id = ?").run("a2", "session-a");

    const res = await app.request("/auth/legal/accept-owner", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const row = rawDb.prepare(`
      SELECT owner_id AS ownerId, restaurant_id AS restaurantId
      FROM legal_acceptances
      WHERE acceptance_type = 'owner_terms'
    `).get() as { ownerId: string | null; restaurantId: string } | null;
    expect(row).toEqual({ ownerId: "owner-a", restaurantId: "a2" });
  });

  test("owner legal acceptance applies across restaurants in the same owner account", async () => {
    rawDb.prepare("DELETE FROM legal_acceptances").run();
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("admin", "a2", "admin-a");
    rawDb.prepare("UPDATE sessions SET active_restaurant_id = ? WHERE id = ?").run("a2", "session-a");
    rawDb.prepare(`
      INSERT INTO legal_acceptances (
        id, owner_id, restaurant_id, user_id, acceptance_type,
        terms_version, dpa_version, privacy_version, subprocessors_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legal-owner-a",
      "owner-a",
      "a1",
      "admin-a",
      "owner_terms",
      OWNER_LEGAL_VERSIONS.terms,
      OWNER_LEGAL_VERSIONS.dpa,
      OWNER_LEGAL_VERSIONS.privacy,
      OWNER_LEGAL_VERSIONS.subprocessors,
    );

    const res = await app.request("/whoami", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        ownerId: "owner-a",
        activeRestaurantId: "a2",
        role: "admin",
      },
    });
  });
});
