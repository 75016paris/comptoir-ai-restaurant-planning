import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-compliance-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { complianceRoutes } = await import("./compliance.js");

const app = new Hono();
app.route("/compliance", complianceRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS published_weeks;
    DROP TABLE IF EXISTS calendar_events;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS sessions;
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
      subscription_status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      disabled_compliance_rules TEXT NOT NULL DEFAULT '[]',
      overtime_mode TEXT NOT NULL DEFAULT 'flexible',
      overtime_weekly_cap INTEGER NOT NULL DEFAULT 48
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
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

    CREATE TABLE worker_restaurant_profiles (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
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
      invited_by_user_id TEXT,
      worker_consented_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      end_date TEXT,
      name TEXT NOT NULL,
      zone TEXT,
      year INTEGER NOT NULL
    );

    CREATE TABLE published_weeks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      week_date TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
  `);
}

beforeEach(() => {
  createSchema();

  const disabledRules = JSON.stringify([
    "HCR-L3121-16",
    "HCR-L3171-1",
    "HCR-L3121-47",
    "HCR-CONGES-PAYES-MINIMUM",
  ]);

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, disabled_compliance_rules) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo", disabledRules);
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, disabled_compliance_rules) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo", disabledRules);

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, priority, active, permissions, sub_roles, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1, 1, null, "[]", 0);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, priority, active, permissions, sub_roles, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-a1", "Worker A1", "worker-a1@example.com", "kitchen", "a1", 1, 1, null, "[]", 0);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, priority, active, permissions, sub_roles, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-a2", "Worker A2", "worker-a2@example.com", "kitchen", "a1", 1, 1, null, "[]", 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  for (const restaurantId of ["a1", "a2"]) {
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run(restaurantId, "admin-a", "admin", null, 1);
  }
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "worker-a1", "kitchen", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-a2", "kitchen", null, 1);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-a1", "member");

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-a1", "worker-a1", "a1", "2026-05-18", "09:00", "18:00", "kitchen", "scheduled", "2026-05-01T09:00:00.000Z", "2026-05-01T09:00:00.000Z");

  for (let day = 18; day <= 22; day += 1) {
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`service-a2-${day}`, "worker-a2", "a2", `2026-05-${day}`, "09:00", "20:00", "kitchen", "scheduled", "2026-05-01T09:00:00.000Z", "2026-05-01T09:00:00.000Z");
  }
});

describe("compliance routes active restaurant context", () => {
  test("GET /compliance/check evaluates only the active restaurant", async () => {
    const res = await app.request("/compliance/check?date=2026-05-18", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.summary.workersChecked).toBe(1);
    expect(body.data.violations.map((v: any) => v.workerId)).toContain("worker-a2");
    expect(body.data.violations.map((v: any) => v.workerId)).not.toContain("worker-a1");
    expect(body.data.overtime).toEqual([{
      workerId: "worker-a2",
      workerName: "Worker A2",
      weeklyHours: 55,
      overtimeHours: 16,
      breakdown: { rate110: 4, rate120: 4, rate150: 8 },
    }]);
  });

  test("GET /compliance/check names accepted shared workers from the live scheduling roster", async () => {
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (
        restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("a2", "worker-a1", 1, "[]", 35, 48, 1);
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("share-a1-a2", "owner-a", "a1", "a2", "worker-a1", "kitchen", "accepted", "admin-a", "2026-05-01T09:00:00.000Z");
    for (let day = 18; day <= 22; day += 1) {
      rawDb.prepare(`
        INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`shared-a2-${day}`, "worker-a1", "a2", `2026-05-${day}`, "09:00", "20:00", "kitchen", "scheduled", "2026-05-01T09:00:00.000Z", "2026-05-01T09:00:00.000Z");
    }

    const res = await app.request("/compliance/check?date=2026-05-18", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.overtime).toContainEqual({
      workerId: "worker-a1",
      workerName: "Worker A1",
      weeklyHours: 55,
      overtimeHours: 16,
      breakdown: { rate110: 4, rate120: 4, rate150: 8 },
    });
  });
});
