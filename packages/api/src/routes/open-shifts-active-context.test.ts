import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-open-shifts-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { openShiftRoutes } = await import("./open-shifts.js");

const app = new Hono();
app.route("/open-shifts", openShiftRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS open_shifts;
    DROP TABLE IF EXISTS sessions;
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
      onboarding_completed_at TEXT
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
      expires_at TEXT NOT NULL
    );

    CREATE TABLE open_shifts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      required_sub_roles TEXT NOT NULL DEFAULT '[]',
      message TEXT,
      candidate_ids TEXT NOT NULL DEFAULT '[]',
      rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
      solicited_candidate_ids TEXT NOT NULL DEFAULT '[]',
      last_solicited_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      claimed_at TEXT,
      service_id TEXT,
      expires_at TEXT NOT NULL,
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

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
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
    .run("a2", "admin-a", "admin", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("open-a1", "a1", "admin-a", "2026-05-12", "09:00", "12:00", "floor", "open", "2026-05-12T09:00:00");
  rawDb.prepare(`
    INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("open-a2", "a2", "admin-a", "2026-05-12", "14:00", "18:00", "floor", "open", "2026-05-12T14:00:00");
});

describe("open shift routes active restaurant context", () => {
  test("GET /open-shifts lists only active restaurant open shifts", async () => {
    const res = await app.request("/open-shifts", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["open-a2"]);
  });

  test("cancel only affects active restaurant shifts", async () => {
    const legacy = await app.request("/open-shifts/open-a1/cancel", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/open-shifts/open-a2/cancel", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(active.status).toBe(200);

    const rows = rawDb.query("SELECT id, status FROM open_shifts ORDER BY id").all();
    expect(rows).toEqual([
      { id: "open-a1", status: "open" },
      { id: "open-a2", status: "cancelled" },
    ]);
  });
});
