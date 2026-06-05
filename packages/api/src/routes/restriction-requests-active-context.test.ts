import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-restriction-requests-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { restrictionRequestRoutes } = await import("./restriction-requests.js");

const app = new Hono();
app.route("/restriction-requests", restrictionRequestRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS restriction_requests;
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

    CREATE TABLE restriction_requests (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      effective_from TEXT,
      effective_until TEXT,
      restrictions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      admin_note TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE worker_restrictions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT,
      end_time TEXT,
      reason TEXT,
      effective_from TEXT,
      effective_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertUser(id: string, name: string, email: string, role: string, restaurantId: string) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, role, restaurantId, 1, null, 0);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo");

  insertUser("admin-a", "Admin A", "admin@example.com", "admin", "a1");
  insertUser("worker-a1", "Worker A1", "worker-a1@example.com", "floor", "a1");
  insertUser("worker-a2", "Worker A2", "worker-a2@example.com", "floor", "a2");

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
    INSERT INTO restriction_requests (
      id, worker_id, restaurant_id, kind, restrictions, status, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("req-a1", "worker-a1", "a1", "permanent", '[{"dayOfWeek":1,"reason":"A1"}]', "pending", "A1", "2026-05-12T09:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO restriction_requests (
      id, worker_id, restaurant_id, kind, restrictions, status, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("req-a2", "worker-a2", "a2", "permanent", '[{"dayOfWeek":2,"reason":"A2"}]', "pending", "A2", "2026-05-12T10:00:00.000Z");
});

describe("restriction request routes active restaurant context", () => {
  test("GET /restriction-requests lists only active restaurant requests", async () => {
    const res = await app.request("/restriction-requests", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["req-a2"]);
    expect(body.data[0].workerName).toBe("Worker A2");
  });

  test("approval cannot touch legacy restaurant request and writes active restaurant restrictions", async () => {
    const legacy = await app.request("/restriction-requests/req-a1", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/restriction-requests/req-a2", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", adminNote: "ok" }),
    });
    expect(active.status).toBe(200);

    const restrictions = rawDb.query("SELECT worker_id, restaurant_id, day_of_week, reason FROM worker_restrictions").all();
    expect(restrictions).toEqual([
      { worker_id: "worker-a2", restaurant_id: "a2", day_of_week: 2, reason: "A2" },
    ]);
  });
});
