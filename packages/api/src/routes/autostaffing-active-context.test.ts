import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-autostaffing-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { autostaffingRoutes, generatePlan } = await import("./autostaffing.js");

const app = new Hono();
app.route("/autostaffing", autostaffingRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS worker_availability;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS worker_preferred_schedule;
    DROP TABLE IF EXISTS holiday_requests;
    DROP TABLE IF EXISTS restaurant_closures;
    DROP TABLE IF EXISTS staffing_schedule;
    DROP TABLE IF EXISTS staffing_targets;
    DROP TABLE IF EXISTS service_template_overrides;
    DROP TABLE IF EXISTS service_templates;
    DROP TABLE IF EXISTS staffing_profiles;
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
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'demo',
      subscription_status TEXT NOT NULL DEFAULT 'active',
      open_days TEXT NOT NULL DEFAULT '{"1":"midi"}',
      overtime_mode TEXT NOT NULL DEFAULT 'flexible',
      overtime_weekly_cap INTEGER NOT NULL DEFAULT 48,
      overtime_distribution TEXT NOT NULL DEFAULT 'willing-first',
      worker_preferences_enabled INTEGER NOT NULL DEFAULT 1,
      disabled_compliance_rules TEXT NOT NULL DEFAULT '[]',
      preferred_style TEXT NOT NULL DEFAULT 'equipe-stable',
      custom_weights TEXT,
      hcr_grid TEXT NOT NULL DEFAULT '{}',
      onboarding_completed_at TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      overtime_willing INTEGER NOT NULL DEFAULT 0,
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
      contract_hours INTEGER,
      contract_end_date TEXT,
      contract_type TEXT,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      inactive_from TEXT,
      inactive_until TEXT,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      hourly_rate INTEGER,
      hcr_level TEXT,
      start_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      user_notice_version TEXT,
      user_notice_accepted_at TEXT,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      contract_type TEXT,
      contract_hours INTEGER,
      contract_end_date TEXT,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      hcr_level TEXT,
      hourly_rate INTEGER,
      matricule TEXT,
      manager_notes TEXT,
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
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE staffing_profiles (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      day_priorities TEXT NOT NULL DEFAULT '{}',
      preferred_assignments TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE service_templates (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE service_template_overrides (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );

    CREATE TABLE staffing_targets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT,
      day_of_week INTEGER NOT NULL,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      role_breakdown TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE staffing_schedule (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      week INTEGER NOT NULL
    );

    CREATE TABLE restaurant_closures (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      schedule TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE holiday_requests (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      medical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'worker',
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE worker_availability (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      midi INTEGER NOT NULL DEFAULT 0,
      soir INTEGER NOT NULL DEFAULT 0,
      zones TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE worker_restrictions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      effective_from TEXT,
      effective_until TEXT
    );

    CREATE TABLE worker_preferred_schedule (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      midi INTEGER NOT NULL DEFAULT 0,
      soir INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      source TEXT NOT NULL DEFAULT 'manual',
      filled_as TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name, subscription_status) VALUES (?, ?, ?)")
    .run("owner-a", "Owner A", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo");

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1, null, 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "manager", JSON.stringify({ OPTIMIZE_RUN: false }), 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);
});

describe("autostaffing routes active restaurant context", () => {
  test("POST /autostaffing/preview uses active restaurant permissions before solving", async () => {
    const res = await app.request("/autostaffing/preview", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden — missing permission: OPTIMIZE_RUN" });
  });

  test("generatePlan includes accepted shared worker with source services as constraints only", async () => {
    seedSharedAutostaffingFixture();
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("svc-source", "worker-shared", "a2", "2026-05-04", "10:00", "14:00", "kitchen", "scheduled", "manual");

    const result = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const inputs = (result as any)._modelInputs;
    const worker = inputs.ilpWorkers.find((row: any) => row.id === "worker-shared");

    expect(worker).toMatchObject({
      id: "worker-shared",
      role: "kitchen",
      priority: 1,
      contractHours: 39,
      otCap: 44,
      subRoles: ["Chef"],
      existingWeeklyHours: 4,
      sharedFromRestaurantId: "a2",
      multiRestaurantWilling: true,
      assignmentPoolPenalty: 80,
    });
    expect(inputs.ilpWorkers.find((row: any) => row.id === "worker-local-fixed")).toMatchObject({
      id: "worker-local-fixed",
      multiRestaurantWilling: false,
      assignmentPoolPenalty: 0,
    });
    expect(inputs.ilpWorkers.find((row: any) => row.id === "worker-local-flex")).toMatchObject({
      id: "worker-local-flex",
      multiRestaurantWilling: true,
      assignmentPoolPenalty: 20,
    });
    expect(worker.existingServicesByDate.get("2026-05-04")).toEqual([{ startTime: "10:00", endTime: "14:00" }]);
    expect(inputs.ilpSlots).toHaveLength(1);
    expect(inputs.ilpSlots[0]).toMatchObject({
      date: "2026-05-04",
      role: "kitchen",
      existingFill: 0,
      target: 1,
    });
  });

  test("generatePlan excludes shared worker when source membership no longer matches", async () => {
    seedSharedAutostaffingFixture();
    rawDb.prepare(`
      UPDATE restaurant_memberships
      SET role = ?
      WHERE restaurant_id = ? AND user_id = ?
    `).run("floor", "a2", "worker-shared");

    const result = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const inputs = (result as any)._modelInputs;

    expect(inputs.ilpWorkers.map((row: any) => row.id)).not.toContain("worker-shared");
    expect(inputs.ilpSlots).toHaveLength(1);
    expect(inputs.ilpSlots[0].existingFill).toBe(0);
  });

  test("generatePlan excludes stale accepted share when revoked timestamp exists", async () => {
    seedSharedAutostaffingFixture();
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-accepted");

    const result = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const inputs = (result as any)._modelInputs;

    expect(inputs.ilpWorkers.map((row: any) => row.id)).not.toContain("worker-shared");
    expect(inputs.ilpSlots).toHaveLength(1);
  });

  test("generatePlan excludes shared worker after direct target membership appears", async () => {
    seedSharedAutostaffingFixture();
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("a1", "worker-shared", "manager", 1);

    const result = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const inputs = (result as any)._modelInputs;

    expect(inputs.ilpWorkers.map((row: any) => row.id)).not.toContain("worker-shared");
    expect(inputs.ilpSlots).toHaveLength(1);
  });

  test("generatePlan lets shared workers use default availability when target availability is empty", async () => {
    seedSharedAutostaffingFixture();
    rawDb.prepare("DELETE FROM worker_availability WHERE worker_id = ? AND restaurant_id = ?")
      .run("worker-shared", "a1");

    const result = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const inputs = (result as any)._modelInputs;

    expect(inputs.ilpWorkers.map((row: any) => row.id)).toContain("worker-shared");
    expect(inputs.ilpSlots).toHaveLength(1);
    expect(inputs.availChecker.isAvailable("worker-shared", inputs.ilpSlots[0])).toBe(true);
  });

  test("generatePlan follows target availability zone for shared workers", async () => {
    seedSharedAutostaffingFixture();
    rawDb.prepare(`
      UPDATE worker_availability
      SET midi = ?, soir = ?
      WHERE worker_id = ? AND restaurant_id = ? AND day_of_week = ?
    `).run(0, 1, "worker-shared", "a1", 1);

    const unavailableResult = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const unavailableInputs = (unavailableResult as any)._modelInputs;
    expect(unavailableInputs.availChecker.isAvailable("worker-shared", unavailableInputs.ilpSlots[0])).toBe(false);

    rawDb.prepare(`
      UPDATE worker_availability
      SET midi = ?, soir = ?
      WHERE worker_id = ? AND restaurant_id = ? AND day_of_week = ?
    `).run(1, 0, "worker-shared", "a1", 1);

    const availableResult = await generatePlan("a1", "2026-05-04", undefined, { _buildOnly: true });
    const availableInputs = (availableResult as any)._modelInputs;
    expect(availableInputs.availChecker.isAvailable("worker-shared", availableInputs.ilpSlots[0])).toBe(true);
  });
});

function seedSharedAutostaffingFixture() {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, password_hash, role, restaurant_id, active, priority, sub_roles,
      overtime_willing, multi_restaurant_willing, contract_hours, max_weekly_hours
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "worker-local-fixed",
    "Local Fixed",
    "fixed@example.com",
    "+330000000010",
    "x",
    "kitchen",
    "a1",
    1,
    9,
    '["Chef"]',
    1,
    0,
    39,
    48,
  );
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, password_hash, role, restaurant_id, active, priority, sub_roles,
      overtime_willing, multi_restaurant_willing, contract_hours, max_weekly_hours
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "worker-local-flex",
    "Local Flex",
    "flex@example.com",
    "+330000000011",
    "x",
    "kitchen",
    "a1",
    1,
    9,
    '["Chef"]',
    1,
    1,
    39,
    48,
  );
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-local-fixed", "member");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-local-flex", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("a1", "worker-local-fixed", "kitchen", 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("a1", "worker-local-flex", "kitchen", 1);

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, password_hash, role, restaurant_id, active, priority, sub_roles,
      overtime_willing, multi_restaurant_willing, contract_hours, max_weekly_hours
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "worker-shared",
    "Shared Worker",
    "shared@example.com",
    "+330000000001",
    "x",
    "kitchen",
    "a2",
    1,
    3,
    '["Cuisinier"]',
    1,
    1,
    35,
    48,
  );
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-shared", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("a2", "worker-shared", "kitchen", 1);
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_type, contract_hours, max_weekly_hours,
      admin_ot_override, hcr_level, hourly_rate, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("a1", "worker-shared", 1, '["Chef"]', "CDI", 39, 44, 44, "III-1", 1900, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "share-accepted",
    "owner-a",
    "a2",
    "a1",
    "worker-shared",
    "kitchen",
    "accepted",
    "admin-a",
    "2026-05-01T00:00:00.000Z",
  );
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("availability-shared-target", "worker-shared", "a1", 1, 1, 0, "{}");

  rawDb.prepare("INSERT INTO staffing_profiles (id, restaurant_id, name, sort_order) VALUES (?, ?, ?, ?)")
    .run("profile-a1", "a1", "Default", 0);
  rawDb.prepare(`
    INSERT INTO service_templates (id, restaurant_id, profile_id, role, zone, start_time, end_time, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tpl-a1-kitchen", "a1", "profile-a1", "kitchen", "Midi", "10:00", "14:00", 0);
  rawDb.prepare(`
    INSERT INTO staffing_targets (id, restaurant_id, profile_id, day_of_week, role, zone, count, role_breakdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("target-a1-kitchen", "a1", "profile-a1", 1, "kitchen", "Midi", 1, "{}");
}
