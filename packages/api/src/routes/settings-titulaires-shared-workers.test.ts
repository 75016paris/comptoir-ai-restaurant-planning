import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-settings-titulaires-shared-workers-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { settingsRoutes } = await import("./settings.js");

const app = new Hono();
app.route("/settings", settingsRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS sessions;
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
      subscription_status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      cache_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_type TEXT,
      contract_end_date TEXT,
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      inactive_from TEXT,
      inactive_until TEXT,
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
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
  `);
}

function insertUser(values: {
  id: string;
  name: string;
  role: string;
  restaurantId: string;
  subRoles?: string;
  contractType?: string | null;
  contractHours?: number | null;
}) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, priority, sub_roles,
      contract_type, contract_hours, must_change_password
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, 1, ?, ?, ?, 0)
  `).run(
    values.id,
    values.name,
    `${values.id}@example.com`,
    values.role,
    values.restaurantId,
    values.subRoles ?? "[]",
    values.contractType ?? null,
    values.contractHours ?? null,
  );
}

function seedRows() {
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, subscription_status) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, subscription_status) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo", "active");

  insertUser({ id: "admin-a", name: "Admin A", role: "admin", restaurantId: "a1" });
  insertUser({ id: "worker-local", name: "Local Worker", role: "floor", restaurantId: "a2", subRoles: '["Runner"]', contractType: "CDI", contractHours: 35 });
  insertUser({ id: "worker-shared", name: "Shared Worker", role: "floor", restaurantId: "a1", subRoles: '["SourceOnly"]', contractType: "CDI", contractHours: 39 });

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
      restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("a2", "worker-shared", 2, '["Renfort"]', 24, 35, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-a1-a2", "owner-a", "a1", "a2", "worker-shared", "floor", "accepted", "admin-a", "2026-05-01T10:00:00.000Z", null);

  rawDb.prepare(`
    INSERT INTO staffing_profiles (id, restaurant_id, name, sort_order, preferred_assignments)
    VALUES (?, ?, ?, ?, ?)
  `).run("profile-a2", "a2", "Default", 1, JSON.stringify([
    { workerId: "worker-shared", dayOfWeek: 1, zone: "midi", role: "floor" },
  ]));

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);
}

beforeEach(() => {
  createSchema();
  seedRows();
});

describe("settings titulaires shared-worker roster", () => {
  test("lists accepted shared workers with target scheduling fields only", async () => {
    const res = await app.request("/settings/staffing-profiles/profile-a2/titulaires", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shared = body.data.workers.find((worker: { id: string }) => worker.id === "worker-shared");
    expect(shared).toMatchObject({
      id: "worker-shared",
      name: "Shared Worker",
      role: "floor",
      subRoles: ["Renfort"],
      contractHours: 24,
      contractType: null,
      contractEndDate: null,
      active: true,
      staleness: null,
    });
    expect(body.data.assignments).toEqual([
      { workerId: "worker-shared", dayOfWeek: 1, zone: "midi", role: "floor" },
    ]);
  });

  test("allows saving accepted shared workers and rejects them after revocation", async () => {
    const live = await app.request("/settings/staffing-profiles/profile-a2/titulaires", {
      method: "PUT",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        assignments: [{ workerId: "worker-shared", dayOfWeek: 2, zone: "soir", role: "floor" }],
      }),
    });
    expect(live.status).toBe(200);

    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-a1-a2");

    const stale = await app.request("/settings/staffing-profiles/profile-a2/titulaires", {
      method: "PUT",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        assignments: [{ workerId: "worker-shared", dayOfWeek: 2, zone: "soir", role: "floor" }],
      }),
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ error: "Un ou plusieurs employés sont introuvables" });
  });
});
