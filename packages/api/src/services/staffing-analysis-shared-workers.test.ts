import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-staffing-analysis-shared-workers-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { analyzeStaffing } = await import("./staffing-analysis.js");

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS worker_availability;
    DROP TABLE IF EXISTS service_template_overrides;
    DROP TABLE IF EXISTS service_templates;
    DROP TABLE IF EXISTS staffing_targets;
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
      name TEXT NOT NULL
    );

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'demo',
      open_days TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_type TEXT,
      contract_end_date TEXT,
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      inactive_from TEXT,
      inactive_until TEXT
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
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
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
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE staffing_targets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      count INTEGER NOT NULL,
      role_breakdown TEXT
    );

    CREATE TABLE service_templates (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );

    CREATE TABLE service_template_overrides (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
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
      reason TEXT
    );
  `);
}

function seedRows() {
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, open_days) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", '{"1":"midi"}');
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, open_days) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", '{"1":"midi"}');

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, priority, sub_roles,
      contract_type, contract_hours, max_weekly_hours
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a2", 1, "[]", null, null, null);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, priority, sub_roles,
      contract_type, contract_hours, max_weekly_hours
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run("worker-local", "Local Worker", "local@example.com", "floor", "a2", 1, '["Runner"]', "CDI", 35, 39);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, priority, sub_roles,
      contract_type, contract_hours, max_weekly_hours
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run("worker-shared", "Shared Worker", "shared@example.com", "floor", "a1", 5, '["SourceOnly"]', "CDI", 39, 44);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-shared", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-local", "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "worker-shared", "floor", null, 1);

  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, admin_ot_override, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("a2", "worker-shared", 2, '["Renfort"]', 24, 32, 34, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-a1-a2", "owner-a", "a1", "a2", "worker-shared", "floor", "accepted", "admin-a", "2026-05-01T10:00:00.000Z", null);

  rawDb.prepare("INSERT INTO staffing_profiles (id, restaurant_id, name, sort_order) VALUES (?, ?, ?, ?)")
    .run("profile-a2", "a2", "Default", 1);
  rawDb.prepare(`
    INSERT INTO staffing_targets (id, restaurant_id, profile_id, day_of_week, role, zone, count, role_breakdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("target-floor-monday", "a2", "profile-a2", 1, "floor", "midi", 2, '{"Renfort":1}');
  rawDb.prepare(`
    INSERT INTO service_templates (id, restaurant_id, profile_id, role, zone, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("tpl-floor-midi", "a2", "profile-a2", "floor", "midi", "10:00", "14:00");
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("avail-local", "worker-local", "a2", 1, 1, 0, "{}");
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("avail-shared", "worker-shared", "a2", 1, 1, 0, "{}");
}

beforeEach(() => {
  createSchema();
  seedRows();
});

describe("staffing analysis shared-worker roster", () => {
  test("includes accepted shared workers using target scheduling profile fields", () => {
    const result = analyzeStaffing("a2", "profile-a2");

    expect(result.roles.find((role) => role.role === "floor")?.totalWorkers).toBe(2);
    expect(result.slots.find((slot) => slot.role === "floor" && slot.dayOfWeek === 1 && slot.zone === "midi")).toMatchObject({
      available: 2,
      availableNames: ["Local Worker", "Shared Worker"],
      subRoleGaps: [{ subRole: "Renfort", needed: 1, available: 1, gap: 0 }],
    });
    expect(result.capacity.find((role) => role.role === "floor")).toMatchObject({
      totalContractHours: 59,
    });
    expect(result.workerLoads.find((worker) => worker.workerId === "worker-shared")).toMatchObject({
      workerName: "Shared Worker",
      role: "floor",
      contractType: null,
      contractHours: 24,
      maxWeeklyHours: 34,
      subRoles: ["Renfort"],
      employmentActionEligible: false,
      sharedFromRestaurantId: "a1",
    });
  });

  test("hides stale accepted-share workers after revocation", () => {
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-a1-a2");

    const result = analyzeStaffing("a2", "profile-a2");

    expect(result.roles.find((role) => role.role === "floor")?.totalWorkers).toBe(1);
    expect(result.workerLoads.map((worker) => worker.workerId)).not.toContain("worker-shared");
    expect(result.slots.find((slot) => slot.role === "floor" && slot.dayOfWeek === 1 && slot.zone === "midi")).toMatchObject({
      available: 1,
      availableNames: ["Local Worker"],
      subRoleGaps: [{ subRole: "Renfort", needed: 1, available: 0, gap: -1 }],
    });
  });
});
