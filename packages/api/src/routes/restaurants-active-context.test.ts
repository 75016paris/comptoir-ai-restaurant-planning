import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-restaurants-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { restaurantRoutes } = await import("./restaurants.js");
const { forbiddenShareResponseFields } = await import("../test/shared-worker-privacy-fields.js");

const app = new Hono();
app.route("/restaurants", restaurantRoutes);

const FORBIDDEN_WORKER_SHARE_FIELDS = [...forbiddenShareResponseFields];
const ALLOWED_WORKER_SHARE_AUDIT_CHANGE_FIELDS = new Set([
  "sourceRestaurantId",
  "targetRestaurantId",
  "userId",
  "role",
  "status",
]);

function expectSchedulingIdentityOnly(row: Record<string, unknown>) {
  for (const field of FORBIDDEN_WORKER_SHARE_FIELDS) {
    expect(row).not.toHaveProperty(field);
  }
}

function expectWorkerShareAuditMetadataOnly(row: { changes: string | null; summary: string | null }) {
  const changes = row.changes ? JSON.parse(row.changes) : {};
  for (const field of Object.keys(changes)) {
    expect(ALLOWED_WORKER_SHARE_AUDIT_CHANGE_FIELDS.has(field)).toBe(true);
  }
  for (const field of FORBIDDEN_WORKER_SHARE_FIELDS) {
    expect(changes).not.toHaveProperty(field);
  }
  const auditText = `${row.changes ?? ""} ${row.summary ?? ""}`;
  expect(auditText).not.toContain("SRC-001");
  expect(auditText).not.toContain("Private source note");
}

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS legal_acceptances;
    DROP TABLE IF EXISTS audit_logs;
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
      name TEXT NOT NULL,
      subscription_status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      siret TEXT,
      whatsapp_bot_locale TEXT NOT NULL DEFAULT 'fr',
      school_zone TEXT,
      holiday_zone TEXT,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active',
      subscription_period_end TEXT,
      trial_ends_at TEXT,
      cancel_at TEXT,
      cancellation_reason TEXT,
      cancellation_feedback TEXT,
      cancellation_comment TEXT,
      cancellation_requested_at TEXT,
      open_days TEXT NOT NULL DEFAULT '[2,3,4,5,6,7]',
      medical_mode INTEGER NOT NULL DEFAULT 0,
      tap_in_out_enabled INTEGER NOT NULL DEFAULT 0,
      tap_in_out_admin_confirmation INTEGER NOT NULL DEFAULT 0,
      tap_in_out_mode TEXT NOT NULL DEFAULT 'lateness_only',
      tap_in_counts_as_hours INTEGER NOT NULL DEFAULT 0,
      reminder_frequency TEXT NOT NULL DEFAULT 'off',
      color_scheme TEXT NOT NULL DEFAULT 'classic',
      kitchen_color TEXT NOT NULL DEFAULT 'amber',
      floor_color TEXT NOT NULL DEFAULT 'sky',
      worker_preferences_enabled INTEGER NOT NULL DEFAULT 1,
      auto_staffing_weeks INTEGER NOT NULL DEFAULT 3,
      disabled_compliance_rules TEXT NOT NULL DEFAULT '["HCR-L3121-16"]',
      kitchen_sub_roles TEXT NOT NULL DEFAULT '["Chef","Cuisinier"]',
      floor_sub_roles TEXT NOT NULL DEFAULT '["Chef de rang","Serveur"]',
      overtime_mode TEXT NOT NULL DEFAULT 'flexible',
      overtime_weekly_cap INTEGER NOT NULL DEFAULT 48,
      overtime_distribution TEXT NOT NULL DEFAULT 'willing-first',
      hcr_grid TEXT NOT NULL DEFAULT '{}',
      subrole_hcr_map TEXT NOT NULL DEFAULT '{}',
      default_contract_type TEXT NOT NULL DEFAULT 'CDI',
      default_contract_hours INTEGER NOT NULL DEFAULT 35,
      preferred_style TEXT NOT NULL DEFAULT 'equipe-stable',
      custom_weights TEXT,
      latitude REAL,
      longitude REAL,
      cache_version INTEGER NOT NULL DEFAULT 0,
      revenue_per_covered_slot_cents INTEGER,
      onboarding_completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      user_notice_version TEXT,
      user_notice_accepted_at TEXT,
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 1,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE owner_memberships (
      owner_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, user_id)
    );

    CREATE TABLE restaurant_memberships (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE worker_restaurant_profiles (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_type TEXT,
      contract_hours INTEGER,
      contract_end_date TEXT,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      hcr_level TEXT,
      hourly_rate INTEGER,
      matricule TEXT,
      manager_notes TEXT,
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (restaurant_id, user_id)
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
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

    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      source TEXT NOT NULL,
      changes TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name, subscription_status) VALUES (?, ?, ?)").run("owner-a", "Owner A", "active");
  rawDb.prepare("INSERT INTO owners (id, name, subscription_status) VALUES (?, ?, ?)").run("owner-b", "Owner B", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "active", "2026-05-01T00:00:00.000Z");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta Local", "active", "2026-05-01T00:00:00.000Z");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?)")
    .run("a3", "owner-a", "Beta Annex", "active", "2026-05-01T00:00:00.000Z");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?)")
    .run("b1", "owner-b", "Gamma", "active", "2026-05-01T00:00:00.000Z");

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("manager-a", "Manager A", "manager@example.com", "manager", "a1", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-a2", "Worker A2", "worker-a2@example.com", "kitchen", "a2", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-a1", "Worker A1", "worker-a1@example.com", "floor", "a1", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "manager-a", "owner_manager");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-a2", "member");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-a1", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "manager", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "manager-a", "manager", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-a2", "kitchen", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a3", "worker-a2", "kitchen", null, 1);
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_type, contract_hours, hourly_rate, matricule, manager_notes, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("a2", "worker-a2", 3, '["Chef"]', "CDI", 39, 1800, "SRC-001", "Private source note", 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "worker-a1", "floor", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-admin", "admin-a", "a1", future);
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-owner-admin-local-manager", "admin-a", "a2", future);
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-manager", "manager-a", "a1", future);
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-worker-a2", "worker-a2", "a2", future);

  rawDb.prepare(`
    INSERT INTO legal_acceptances (
      id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legal-a1", "owner-a", "a1", "admin-a", "owner_terms", "2026-05-11", "2026-05-11", "2026-05-11", "2026-05-11");
});

describe("restaurant management routes", () => {
  test("owner admin can create a second restaurant under the current owner", async () => {
    const res = await app.request("/restaurants", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Beta", address: "2 rue Test" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({
      ownerId: "owner-a",
      name: "Beta",
      address: "2 rue Test",
      onboardingCompletedAt: null,
    });

    const membership = rawDb.query(`
      SELECT role, active FROM restaurant_memberships
      WHERE restaurant_id = ? AND user_id = ?
    `).get(body.data.id, "admin-a");
    expect(membership).toEqual({ role: "admin", active: 1 });
  });

  test("new restaurant mirrors owner subscription status during migration", async () => {
    rawDb.prepare("UPDATE owners SET subscription_status = ? WHERE id = ?").run("cancelled", "owner-a");

    const res = await app.request("/restaurants", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Blocked Mirror" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const row = rawDb.query("SELECT subscription_status AS subscriptionStatus FROM restaurants WHERE id = ?")
      .get(body.data.id);
    expect(row).toEqual({ subscriptionStatus: "cancelled" });
  });

  test("new restaurants created from demo context stay demo to avoid legal gate lockout", async () => {
    rawDb.prepare("UPDATE restaurants SET status = ? WHERE id = ?").run("demo", "a1");

    const res = await app.request("/restaurants", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Demo Annex" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("demo");
    const row = rawDb.query("SELECT status FROM restaurants WHERE id = ?")
      .get(body.data.id);
    expect(row).toEqual({ status: "demo" });
  });

  test("owner admin can create even when active restaurant role is manager", async () => {
    const res = await app.request("/restaurants", {
      method: "POST",
      headers: { cookie: "session=session-owner-admin-local-manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Gamma Local" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ ownerId: "owner-a", name: "Gamma Local" });
  });

  test("non-owner admins/managers cannot create restaurants", async () => {
    const res = await app.request("/restaurants", {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Blocked" }),
    });

    expect(res.status).toBe(403);
  });

  test("patch is limited to restaurants in the current owner", async () => {
    const foreign = await app.request("/restaurants/b1", {
      method: "PATCH",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Wrong" }),
    });
    expect(foreign.status).toBe(404);

    const own = await app.request("/restaurants/a1", {
      method: "PATCH",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Alpha Updated" }),
    });
    expect(own.status).toBe(200);

    const rows = rawDb.query("SELECT id, name FROM restaurants ORDER BY id").all();
    expect(rows).toContainEqual({ id: "a1", name: "Alpha Updated" });
    expect(rows).toContainEqual({ id: "b1", name: "Gamma" });
  });

  test("owner admin can patch owned restaurants even when active restaurant role is manager", async () => {
    const res = await app.request("/restaurants/a1", {
      method: "PATCH",
      headers: { cookie: "session=session-owner-admin-local-manager", "content-type": "application/json" },
      body: JSON.stringify({ name: "Alpha Owner Patched" }),
    });

    expect(res.status).toBe(200);
    const row = rawDb.query("SELECT name FROM restaurants WHERE id = ?").get("a1");
    expect(row).toEqual({ name: "Alpha Owner Patched" });
  });

  test("owner manager lists shareable workers with scheduling identity only", async () => {
    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{
      id: "worker-a2",
      name: "Worker A2",
      role: "kitchen",
      sourceRestaurantId: "a2",
      sourceRestaurantName: "Beta Local",
    }]);
    expectSchedulingIdentityOnly(body.data[0]);
  });

  test("shareable workers endpoint filters role and rejects cross-owner source", async () => {
    const filtered = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=floor", {
      headers: { cookie: "session=session-manager" },
    });
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).data).toEqual([]);

    const foreign = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=b1", {
      headers: { cookie: "session=session-manager" },
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "restaurant_not_found" });
  });

  test("shareable workers endpoint uses restaurant membership role over legacy global role", async () => {
    rawDb.prepare(`
      INSERT INTO users (
        id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-manager-worker", "Legacy Manager Worker", "legacy-manager-worker@example.com", "manager", "a2", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-a", "legacy-manager-worker", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a2", "legacy-manager-worker", "kitchen", null, 1);

    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["legacy-manager-worker", "worker-a2"]);
  });

  test("shareable workers endpoint excludes inactive users", async () => {
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run("worker-a2");

    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  test("shareable workers endpoint excludes source workers outside the owner account", async () => {
    rawDb.prepare(`
      INSERT INTO users (
        id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("orphan-source-worker", "Orphan Source Worker", "orphan-source-worker@example.com", "kitchen", "a2", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a2", "orphan-source-worker", "kitchen", null, 1);

    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);
  });

  test("shareable workers endpoint returns stable validation errors", async () => {
    const missingSource = await app.request("/restaurants/a1/shareable-workers", {
      headers: { cookie: "session=session-manager" },
    });
    expect(missingSource.status).toBe(400);
    expect(await missingSource.json()).toEqual({ error: "source_restaurant_required" });

    const invalidRole = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=bar", {
      headers: { cookie: "session=session-manager" },
    });
    expect(invalidRole.status).toBe(400);
    expect(await invalidRole.json()).toEqual({ error: "invalid_role" });

    const sameRestaurant = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a1", {
      headers: { cookie: "session=session-manager" },
    });
    expect(sameRestaurant.status).toBe(400);
    expect(await sameRestaurant.json()).toEqual({ error: "same_restaurant" });
  });

  test("worker share management reads reject non-owner managers", async () => {
    const shareable = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a3&role=kitchen", {
      headers: { cookie: "session=session-worker-a2" },
    });
    expect(shareable.status).toBe(403);
    expect(await shareable.json()).toEqual({ error: "owner_manager_required" });

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-worker-a2" },
    });
    expect(shares.status).toBe(403);
    expect(await shares.json()).toEqual({ error: "owner_manager_required" });
  });

  test("shareable workers endpoint hides authorized shares and returns revoked shares", async () => {
    const before = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });
    expect(before.status).toBe(200);
    expect((await before.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);

    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);

    const authorized = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });
    expect(authorized.status).toBe(200);
    expect((await authorized.json()).data).toEqual([]);

    const inviteBody = await invite.json();
    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });
    expect(revoke.status).toBe(200);

    const revoked = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a2&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);
  });

  test("shareable workers endpoint hides active shares from sibling sources too", async () => {
    const before = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a3&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });
    expect(before.status).toBe(200);
    expect((await before.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);

    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);

    const after = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a3&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });
    expect(after.status).toBe(200);
    expect((await after.json()).data).toEqual([]);
  });

  test("shareable workers endpoint ignores stale active shares after original source membership is inactive", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("a2", "worker-a2");

    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a3&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);
  });

  test("shareable workers endpoint ignores stale active shares after original source role changes", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("floor", "a2", "worker-a2");

    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=a3&role=kitchen", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);
  });

  test("owner admin can authorize a same-owner worker share immediately", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });

    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();
    expect(inviteBody.data).toMatchObject({
      ownerId: "owner-a",
      sourceRestaurantId: "a2",
      targetRestaurantId: "a1",
      userId: "worker-a2",
      role: "kitchen",
      status: "accepted",
    });
    expect(inviteBody.data.workerConsentedAt).toBeTruthy();

    const targetProfile = rawDb.query(`
      SELECT
        priority,
        sub_roles AS subRoles,
        contract_type AS contractType,
        contract_hours AS contractHours,
        hourly_rate AS hourlyRate,
        matricule,
        manager_notes AS managerNotes,
        multi_restaurant_willing AS multiRestaurantWilling
      FROM worker_restaurant_profiles
      WHERE restaurant_id = ? AND user_id = ?
    `).get("a1", "worker-a2");
    expect(targetProfile).toEqual({
      priority: 1,
      subRoles: "[]",
      contractType: null,
      contractHours: null,
      hourlyRate: null,
      matricule: null,
      managerNotes: null,
      multiRestaurantWilling: 1,
    });

    const auditRows = rawDb.query(`
      SELECT restaurant_id AS restaurantId, table_name AS tableName, row_id AS rowId, action, actor_id AS actorId, source, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
      ORDER BY created_at, action
    `).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows.map((row) => ({
      restaurantId: row.restaurantId,
      tableName: row.tableName,
      rowId: row.rowId,
      action: row.action,
      actorId: row.actorId,
      source: row.source,
    }))).toEqual([
      {
        restaurantId: "a1",
        tableName: "worker_share_authorizations",
        rowId: inviteBody.data.id,
        action: "insert",
        actorId: "admin-a",
        source: "dashboard",
      },
    ]);
    expect(auditRows[0].summary).toContain("worker-a2");
    expect(auditRows[0].summary).toContain("authorized");
  });

  test("worker cannot answer an owner-authorized worker share", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const firstAccept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(firstAccept.status).toBe(404);
    expect(await firstAccept.json()).toEqual({ error: "authorization_not_pending" });

    const secondAccept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(secondAccept.status).toBe(404);
    expect(await secondAccept.json()).toEqual({ error: "authorization_not_pending" });

    const lateDecline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(lateDecline.status).toBe(404);
    expect(await lateDecline.json()).toEqual({ error: "authorization_not_pending" });

    const share = rawDb.query("SELECT status FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "accepted" });
    const auditRows = rawDb.query(`
      SELECT action, actor_id AS actorId, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "insert", actorId: "admin-a" });
    expect(auditRows[0].summary).toContain("authorized");
  });

  test("worker share audit logs stay limited to sharing metadata", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });
    expect(revoke.status).toBe(200);

    const reinvite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(reinvite.status).toBe(201);

    const auditRows = rawDb.query(`
      SELECT changes, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
      ORDER BY created_at, action
    `).all() as Array<{ changes: string | null; summary: string | null }>;
    expect(auditRows).toHaveLength(3);
    for (const row of auditRows) {
      expectWorkerShareAuditMetadataOnly(row);
    }
  });

  test("worker share invite is idempotent without duplicate insert audit", async () => {
    const first = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.id).toBe(firstBody.data.id);

    const auditRows = rawDb.query(`
      SELECT row_id AS rowId, action, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toEqual([{
      rowId: firstBody.data.id,
      action: "insert",
      summary: "Worker share authorized: worker-a2 from a2 to a1",
    }]);
  });

  test("worker share invite ignores stale duplicate rows from a previous owner", async () => {
    const stale = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(stale.status).toBe(201);
    const staleBody = await stale.json();

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");
    rawDb.prepare(`
      INSERT INTO users (
        id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("admin-b", "Admin B", "admin-b@example.com", "admin", "b1", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-b", "admin-b", "owner_admin");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-b", "worker-a2", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("b1", "admin-b", "admin", null, 1);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("b1", "worker-a2", "kitchen", null, 1);
    rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
      .run("session-admin-b", "admin-b", "b1", new Date(Date.now() + 60_000).toISOString());
    rawDb.prepare(`
      INSERT INTO legal_acceptances (
        id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legal-b1", "owner-b", "b1", "admin-b", "owner_terms", "2026-05-11", "2026-05-11", "2026-05-11", "2026-05-11");

    const fresh = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin-b", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "b1", userId: "worker-a2", role: "kitchen" }),
    });

    expect(fresh.status).toBe(201);
    const freshBody = await fresh.json();
    expect(freshBody.data).toMatchObject({
      ownerId: "owner-b",
      sourceRestaurantId: "b1",
      targetRestaurantId: "a1",
      userId: "worker-a2",
      role: "kitchen",
      status: "accepted",
    });
    expect(freshBody.data.id).not.toBe(staleBody.data.id);

    const rows = rawDb.query(`
      SELECT owner_id AS ownerId, source_restaurant_id AS sourceRestaurantId, target_restaurant_id AS targetRestaurantId
      FROM worker_share_authorizations
      WHERE target_restaurant_id = ? AND user_id = ? AND role = ?
      ORDER BY owner_id
    `).all("a1", "worker-a2", "kitchen") as any[];
    expect(rows).toEqual([
      { ownerId: "owner-a", sourceRestaurantId: "a2", targetRestaurantId: "a1" },
      { ownerId: "owner-b", sourceRestaurantId: "b1", targetRestaurantId: "a1" },
    ]);
  });

  test("worker share invite reuses stale active duplicate after source role changes", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("floor", "a2", "worker-a2");

    const reInvite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a3", userId: "worker-a2", role: "kitchen" }),
    });

    expect(reInvite.status).toBe(201);
    const reInviteBody = await reInvite.json();
    expect(reInviteBody.data).toMatchObject({
      id: inviteBody.data.id,
      sourceRestaurantId: "a3",
      targetRestaurantId: "a1",
      userId: "worker-a2",
      role: "kitchen",
      status: "accepted",
      revokedAt: null,
    });
    expect(reInviteBody.data.workerConsentedAt).toBeTruthy();
    const audit = rawDb.query(`
      SELECT action, summary, changes
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
        AND summary = ?
      LIMIT 1
    `).get("Worker share re-authorized: worker-a2 from a3 to a1") as any;
    expect(audit.action).toBe("update");
    expect(audit.summary).toBe("Worker share re-authorized: worker-a2 from a3 to a1");
    expect(JSON.parse(audit.changes).status).toEqual({ old: "accepted", new: "accepted" });
  });

  test("worker share invite reuses stale active duplicate after source membership is inactive", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();
    rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("a2", "worker-a2");

    const reInvite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a3", userId: "worker-a2", role: "kitchen" }),
    });

    expect(reInvite.status).toBe(201);
    const reInviteBody = await reInvite.json();
    expect(reInviteBody.data).toMatchObject({
      id: inviteBody.data.id,
      sourceRestaurantId: "a3",
      targetRestaurantId: "a1",
      userId: "worker-a2",
      role: "kitchen",
      status: "accepted",
      revokedAt: null,
    });
    expect(reInviteBody.data.workerConsentedAt).toBeTruthy();
  });

  test("shareable workers endpoint ignores stale active shares from a previous owner", async () => {
    const stale = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(stale.status).toBe(201);

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");
    rawDb.prepare(`
      INSERT INTO users (
        id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("admin-b", "Admin B", "admin-b@example.com", "admin", "b1", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-b", "admin-b", "owner_admin");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-b", "worker-a2", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("b1", "admin-b", "admin", null, 1);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("b1", "worker-a2", "kitchen", null, 1);
    rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
      .run("session-admin-b", "admin-b", "b1", new Date(Date.now() + 60_000).toISOString());
    rawDb.prepare(`
      INSERT INTO legal_acceptances (
        id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legal-b1", "owner-b", "b1", "admin-b", "owner_terms", "2026-05-11", "2026-05-11", "2026-05-11", "2026-05-11");

    const res = await app.request("/restaurants/a1/shareable-workers?sourceRestaurantId=b1&role=kitchen", {
      headers: { cookie: "session=session-admin-b" },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.map((row: any) => row.id)).toEqual(["worker-a2"]);
  });

  test.skip("worker cannot accept share after source membership is inactive", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare(`
      UPDATE restaurant_memberships
      SET active = 0
      WHERE restaurant_id = ? AND user_id = ? AND role = ?
    `).run("a2", "worker-a2", "kitchen");

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(409);
    const body = await accept.json();
    expect(body.error).toBe("source_membership_required");
  });

  test.skip("worker cannot accept share after source membership role changes", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare(`
      UPDATE restaurant_memberships
      SET role = ?
      WHERE restaurant_id = ? AND user_id = ? AND role = ?
    `).run("floor", "a2", "worker-a2", "kitchen");

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(409);
    expect(await accept.json()).toEqual({ error: "source_membership_required" });
    const share = rawDb.query("SELECT status, worker_consented_at AS workerConsentedAt FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "pending", workerConsentedAt: null });
  });

  test.skip("worker cannot accept share after leaving the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-a", "worker-a2");

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(409);
    expect(await accept.json()).toEqual({ error: "source_membership_required" });
  });

  test.skip("worker cannot accept share after source restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a2");

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(400);
    expect(await accept.json()).toEqual({ error: "owner_mismatch" });
  });

  test.skip("worker cannot accept share after target restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(400);
    expect(await accept.json()).toEqual({ error: "owner_mismatch" });
  });

  test.skip("inactive workers cannot accept share invitations", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run("worker-a2");

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(403);
    expect(await accept.json()).toEqual({ error: "Ce compte a été désactivé" });
  });

  test.skip("worker cannot accept share after joining the target restaurant directly", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a1", "worker-a2", "kitchen", null, 1);

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(accept.status).toBe(409);
    const body = await accept.json();
    expect(body.error).toBe("target_membership_exists");
  });

  test("worker share authorization creates a clean target profile without copying source HR fields", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();
    expect(inviteBody.data.status).toBe("accepted");

    const targetProfile = rawDb.query(`
      SELECT
        priority,
        sub_roles AS subRoles,
        contract_type AS contractType,
        contract_hours AS contractHours,
        contract_end_date AS contractEndDate,
        max_weekly_hours AS maxWeeklyHours,
        admin_ot_override AS adminOtOverride,
        hcr_level AS hcrLevel,
        hourly_rate AS hourlyRate,
        matricule,
        manager_notes AS managerNotes,
        multi_restaurant_willing AS multiRestaurantWilling
      FROM worker_restaurant_profiles
      WHERE restaurant_id = ? AND user_id = ?
    `).get("a1", "worker-a2");

    expect(targetProfile).toEqual({
      priority: 1,
      subRoles: "[]",
      contractType: null,
      contractHours: null,
      contractEndDate: null,
      maxWeeklyHours: null,
      adminOtOverride: null,
      hcrLevel: null,
      hourlyRate: null,
      matricule: null,
      managerNotes: null,
      multiRestaurantWilling: 1,
    });
  });

  test("worker share authorization preserves an existing target worker profile", async () => {
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (
        restaurant_id, user_id, priority, sub_roles, manager_notes, multi_restaurant_willing
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("a1", "worker-a2", 2, '["Target role"]', "Target-local note", 0);

    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();
    expect(inviteBody.data.status).toBe("accepted");

    const targetProfile = rawDb.query(`
      SELECT priority, sub_roles AS subRoles, manager_notes AS managerNotes
      FROM worker_restaurant_profiles
      WHERE restaurant_id = ? AND user_id = ?
    `).get("a1", "worker-a2");
    expect(targetProfile).toEqual({
      priority: 2,
      subRoles: '["Target role"]',
      managerNotes: "Target-local note",
    });
  });

  test("worker share re-invite after revoke is audited as an update", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });
    expect(revoke.status).toBe(200);

    const reinvite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(reinvite.status).toBe(201);
    const reinviteBody = await reinvite.json();
    expect(reinviteBody.data).toMatchObject({
      id: inviteBody.data.id,
      status: "accepted",
      revokedAt: null,
    });

    const auditRows = rawDb.query(`
      SELECT row_id AS rowId, action, changes, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(3);
    const reInviteAudit = auditRows.find((row) => row.summary.includes("re-authorized"));
    expect(reInviteAudit).toMatchObject({
      rowId: inviteBody.data.id,
      action: "update",
      summary: "Worker share re-authorized: worker-a2 from a2 to a1",
    });
    expect(JSON.parse(reInviteAudit.changes).status).toEqual({ old: "revoked", new: "accepted" });
  });

  test("owner manager lists worker shares with scheduling identity only", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-owner-admin-local-manager", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const firstInviteBody = await invite.json();

    rawDb.prepare(`
      INSERT INTO users (
        id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("worker-a3", "Worker A3", "worker-a3@example.com", "kitchen", "a3", 1, null, 0, "2026-05-11", "2026-05-11T00:00:00.000Z");
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-a", "worker-a3", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a3", "worker-a3", "kitchen", null, 1);

    const secondInvite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a3", userId: "worker-a3", role: "kitchen" }),
    });
    expect(secondInvite.status).toBe(201);
    const secondInviteBody = await secondInvite.json();
    rawDb.prepare("UPDATE worker_share_authorizations SET updated_at = ? WHERE id = ?")
      .run("2026-05-01T10:00:00.000Z", firstInviteBody.data.id);
    rawDb.prepare("UPDATE worker_share_authorizations SET updated_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", secondInviteBody.data.id);

    const res = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data.map((row: any) => row.userId)).toEqual(["worker-a3", "worker-a2"]);
    expect(body.data[1]).toMatchObject({
      sourceRestaurantId: "a2",
      sourceRestaurantName: "Beta Local",
      targetRestaurantId: "a1",
      targetRestaurantName: "Alpha",
      userId: "worker-a2",
      workerName: "Worker A2",
      role: "kitchen",
      status: "accepted",
    });
    body.data.forEach(expectSchedulingIdentityOnly);
  });

  test("worker share list returns stable validation errors", async () => {
    const missingTarget = await app.request("/restaurants/missing/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });
    expect(missingTarget.status).toBe(404);
    expect(await missingTarget.json()).toEqual({ error: "restaurant_not_found" });
  });

  test("worker share list hides stale shares after source restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a2");

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(shares.status).toBe(200);
    expect((await shares.json()).data).toEqual([]);
  });

  test("worker share list hides stale shares after source membership role changes", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("floor", "a2", "worker-a2");

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(shares.status).toBe(200);
    expect((await shares.json()).data).toEqual([]);
  });

  test("worker share list hides stale shares after source membership is inactive", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("a2", "worker-a2");

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(shares.status).toBe(200);
    expect((await shares.json()).data).toEqual([]);
  });

  test("worker share list hides stale shares after worker leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-a", "worker-a2");

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(shares.status).toBe(200);
    expect((await shares.json()).data).toEqual([]);
  });

  test("worker share list hides stale shares after worker account is inactive", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?")
      .run("worker-a2");

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(shares.status).toBe(200);
    expect((await shares.json()).data).toEqual([]);
  });

  test("worker share list hides stale shares after direct target membership is created", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a1", "worker-a2", "kitchen", null, 1);

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-manager" },
    });

    expect(shares.status).toBe(200);
    expect((await shares.json()).data).toEqual([]);
  });

  test("worker share list rejects target restaurants after they leave the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");

    const shares = await app.request("/restaurants/a1/worker-shares", {
      headers: { cookie: "session=session-owner-admin-local-manager" },
    });

    expect(shares.status).toBe(404);
    expect(await shares.json()).toEqual({ error: "restaurant_not_found" });
  });

  test.skip("worker can list and decline own pending worker share invitations", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const pending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json();
    expect(pendingBody.data.map((row: any) => row.id)).toEqual([inviteBody.data.id]);
    expect(pendingBody.data[0]).toMatchObject({
      sourceRestaurantName: "Beta Local",
      targetRestaurantName: "Alpha",
    });
    expectSchedulingIdentityOnly(pendingBody.data[0]);

    const decline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(decline.status).toBe(200);
    const declined = await decline.json();
    expect(declined.data).toMatchObject({ id: inviteBody.data.id, status: "revoked" });

    const afterDecline = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });
    expect((await afterDecline.json()).data).toEqual([]);

    const auditRows = rawDb.query(`
      SELECT restaurant_id AS restaurantId, row_id AS rowId, action, actor_id AS actorId, changes, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
      ORDER BY created_at, action
    `).all() as any[];
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1]).toMatchObject({
      restaurantId: "a1",
      rowId: inviteBody.data.id,
      action: "update",
      actorId: "worker-a2",
    });
    expect(JSON.parse(auditRows[1].changes)).toEqual({ status: { old: "pending", new: "revoked" } });
    expect(auditRows[1].summary).toContain("declined");
  });

  test.skip("worker share decline leaves the target restaurant without a worker profile", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();

    const decline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(decline.status).toBe(200);

    const targetProfile = rawDb.query(`
      SELECT restaurant_id AS restaurantId, user_id AS userId
      FROM worker_restaurant_profiles
      WHERE restaurant_id = ? AND user_id = ?
    `).get("a1", "worker-a2");
    expect(targetProfile).toBeNull();
  });

  test("worker pending shares hide stale shares after source restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a2");

    const pending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });

    expect(pending.status).toBe(200);
    expect((await pending.json()).data).toEqual([]);
  });

  test("worker pending shares hide stale shares after target restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");

    const pending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });

    expect(pending.status).toBe(200);
    expect((await pending.json()).data).toEqual([]);
  });

  test("worker pending shares hide invitations after source membership is inactive", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);

    rawDb.prepare(`
      UPDATE restaurant_memberships
      SET active = 0
      WHERE restaurant_id = ? AND user_id = ? AND role = ?
    `).run("a2", "worker-a2", "kitchen");

    const pending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });

    expect(pending.status).toBe(200);
    expect((await pending.json()).data).toEqual([]);
  });

  test("worker pending shares hide invitations after source membership role changes", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);

    rawDb.prepare(`
      UPDATE restaurant_memberships
      SET role = ?
      WHERE restaurant_id = ? AND user_id = ? AND role = ?
    `).run("floor", "a2", "worker-a2", "kitchen");

    const pending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });

    expect(pending.status).toBe(200);
    expect((await pending.json()).data).toEqual([]);
  });

  test("worker pending shares hide invitations after direct target membership is created", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    expect(invite.status).toBe(201);

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a1", "worker-a2", "kitchen", null, 1);

    const pending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });

    expect(pending.status).toBe(200);
    expect((await pending.json()).data).toEqual([]);
  });

  test.skip("worker pending shares are scoped to the active owner context", async () => {
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-b", "worker-a2", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("b1", "worker-a2", "kitchen", null, 1);
    rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
      .run("session-worker-b", "worker-a2", "b1", new Date(Date.now() + 60_000).toISOString());

    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const sourceOwnerPending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-a2" },
    });
    expect(sourceOwnerPending.status).toBe(200);
    expect((await sourceOwnerPending.json()).data.map((row: any) => row.id)).toEqual([inviteBody.data.id]);

    const otherOwnerPending = await app.request("/restaurants/worker-shares/pending", {
      headers: { cookie: "session=session-worker-b" },
    });
    expect(otherOwnerPending.status).toBe(200);
    expect((await otherOwnerPending.json()).data).toEqual([]);
  });

  test.skip("worker cannot decline share after target restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");

    const decline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(decline.status).toBe(400);
    expect(await decline.json()).toEqual({ error: "owner_mismatch" });
    const share = rawDb.query("SELECT status FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "pending" });
  });

  test.skip("worker cannot decline share after source restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a2");

    const decline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(decline.status).toBe(400);
    expect(await decline.json()).toEqual({ error: "owner_mismatch" });
    const share = rawDb.query("SELECT status FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "pending" });
  });

  test.skip("worker cannot answer another worker's share invitation", async () => {
    rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
      .run("session-worker-a1", "worker-a1", "a1", new Date(Date.now() + 60_000).toISOString());
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a1", "content-type": "application/json" },
    });
    expect(accept.status).toBe(404);
    expect(await accept.json()).toEqual({ error: "authorization_not_pending" });

    const decline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a1", "content-type": "application/json" },
    });
    expect(decline.status).toBe(404);
    expect(await decline.json()).toEqual({ error: "authorization_not_pending" });

    const share = rawDb.query("SELECT status FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "pending" });
    const auditRows = rawDb.query(`
      SELECT action, actor_id AS actorId, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "insert", actorId: "admin-a" });
  });

  test.skip("worker cannot answer own share invitation from another active owner context", async () => {
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-b", "worker-a2", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("b1", "worker-a2", "kitchen", null, 1);
    rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
      .run("session-worker-b", "worker-a2", "b1", new Date(Date.now() + 60_000).toISOString());

    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const accept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-b", "content-type": "application/json" },
    });
    expect(accept.status).toBe(400);
    expect(await accept.json()).toEqual({ error: "owner_mismatch" });

    const decline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-b", "content-type": "application/json" },
    });
    expect(decline.status).toBe(400);
    expect(await decline.json()).toEqual({ error: "owner_mismatch" });

    const share = rawDb.query("SELECT status, worker_consented_at AS workerConsentedAt, revoked_at AS revokedAt FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "pending", workerConsentedAt: null, revokedAt: null });
    const auditRows = rawDb.query(`
      SELECT action, actor_id AS actorId, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "insert", actorId: "admin-a" });
  });

  test("owner manager can revoke accepted worker shares", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });

    expect(revoke.status).toBe(200);
    const revoked = await revoke.json();
    expect(revoked.data).toMatchObject({ id: inviteBody.data.id, status: "revoked" });
    expect(revoked.data.revokedAt).toBeTruthy();

    const auditRows = rawDb.query(`
      SELECT restaurant_id AS restaurantId, row_id AS rowId, action, actor_id AS actorId, changes, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
      ORDER BY created_at, action
    `).all() as any[];
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1]).toMatchObject({
      restaurantId: "a1",
      rowId: inviteBody.data.id,
      action: "update",
      actorId: "manager-a",
    });
    expect(JSON.parse(auditRows[1].changes)).toEqual({ status: { old: "accepted", new: "revoked" } });
    expect(auditRows[1].summary).toContain("revoked");
  });

  test("owner admin cannot revoke share after target restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-owner-admin-local-manager", "content-type": "application/json" },
    });

    expect(revoke.status).toBe(400);
    expect(await revoke.json()).toEqual({ error: "owner_mismatch" });
    const share = rawDb.query("SELECT status, revoked_at AS revokedAt FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "accepted", revokedAt: null });
    const auditRows = rawDb.query(`
      SELECT action, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].summary).toContain("authorized");
  });

  test("owner admin cannot revoke share after source restaurant leaves the owner account", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a2");

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });

    expect(revoke.status).toBe(400);
    expect(await revoke.json()).toEqual({ error: "owner_mismatch" });
    const share = rawDb.query("SELECT status, revoked_at AS revokedAt FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "accepted", revokedAt: null });
    const auditRows = rawDb.query(`
      SELECT action, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].summary).toContain("authorized");
  });

  test("worker share revoke is idempotent without duplicate audit", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const first = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data).toMatchObject({ id: inviteBody.data.id, status: "revoked" });
    const firstRevokedAt = (await first.json()).data.revokedAt;
    expect(secondBody.data.revokedAt).toBe(firstRevokedAt);

    const auditRows = rawDb.query(`
      SELECT row_id AS rowId, action, changes, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(2);
    expect(auditRows.filter((row) => row.summary.includes("revoked"))).toHaveLength(1);
  });

  test("worker cannot answer a revoked worker share", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-manager", "content-type": "application/json" },
    });
    expect(revoke.status).toBe(200);

    const lateAccept = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/accept`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(lateAccept.status).toBe(404);
    expect(await lateAccept.json()).toEqual({ error: "authorization_not_pending" });

    const lateDecline = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/decline`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });
    expect(lateDecline.status).toBe(404);
    expect(await lateDecline.json()).toEqual({ error: "authorization_not_pending" });

    const share = rawDb.query("SELECT status FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "revoked" });
    const auditRows = rawDb.query(`
      SELECT action, actor_id AS actorId, summary
      FROM audit_logs
      WHERE table_name = 'worker_share_authorizations'
    `).all() as any[];
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1]).toMatchObject({ action: "update", actorId: "manager-a" });
    expect(auditRows[1].summary).toContain("revoked");
  });

  test("worker cannot revoke worker shares", async () => {
    const invite = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });
    const inviteBody = await invite.json();

    const revoke = await app.request(`/restaurants/worker-shares/${inviteBody.data.id}/revoke`, {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
    });

    expect(revoke.status).toBe(403);
    expect(await revoke.json()).toEqual({ error: "revoker_not_allowed" });
    const share = rawDb.query("SELECT status, revoked_at AS revokedAt FROM worker_share_authorizations WHERE id = ?").get(inviteBody.data.id) as any;
    expect(share).toEqual({ status: "accepted", revokedAt: null });
  });

  test("worker share invite rejects cross-owner restaurants", async () => {
    const res = await app.request("/restaurants/b1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("owner_mismatch");
  });

  test("worker share invite returns stable validation errors", async () => {
    const malformed = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "bar" }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_worker_share_payload" });

    const sameRestaurant = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a1", userId: "worker-a1", role: "floor" }),
    });
    expect(sameRestaurant.status).toBe(400);
    expect(await sameRestaurant.json()).toEqual({ error: "same_restaurant" });
  });

  test("worker share invite rejects inactive source users", async () => {
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run("worker-a2");

    const res = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "source_membership_required" });
  });

  test("worker share invite rejects source workers outside the owner account", async () => {
    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-a", "worker-a2");

    const res = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a2", role: "kitchen" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "source_membership_required" });
  });

  test("worker share invite rejects non-owner managers", async () => {
    const res = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a3", userId: "worker-a2", role: "kitchen" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("inviter_not_allowed");
  });

  test("worker share invite rejects workers already active in the target restaurant", async () => {
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a2", "worker-a1", "floor", null, 1);

    const res = await app.request("/restaurants/a1/worker-shares", {
      method: "POST",
      headers: { cookie: "session=session-admin", "content-type": "application/json" },
      body: JSON.stringify({ sourceRestaurantId: "a2", userId: "worker-a1", role: "floor" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("target_membership_exists");
  });
});
