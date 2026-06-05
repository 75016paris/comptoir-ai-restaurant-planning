import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-timeclock-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { timeClockRoutes } = await import("./timeclock.js");

const app = new Hono();
app.route("/timeclock", timeClockRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS time_clocks;
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
      onboarding_completed_at TEXT,
      tap_in_out_enabled INTEGER NOT NULL DEFAULT 1,
      tap_in_out_admin_confirmation INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      phone TEXT,
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

    CREATE TABLE time_clocks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      service_id TEXT,
      tap_in TEXT NOT NULL,
      tap_out TEXT,
      date TEXT NOT NULL,
      admin_confirmed_at TEXT,
      admin_confirmed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
    );

    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL,
      type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      scheduled_for TEXT NOT NULL,
      sent_at TEXT,
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
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-worker-a2", "worker-a2", "a2", future);

  rawDb.prepare(`
    INSERT INTO time_clocks (id, user_id, restaurant_id, service_id, tap_in, tap_out, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("clock-a1", "worker-a1", "a1", null, "2026-05-12T09:00:00.000Z", null, "2026-05-12", "2026-05-12T09:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO time_clocks (id, user_id, restaurant_id, service_id, tap_in, tap_out, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("clock-a2", "worker-a2", "a2", null, "2026-05-12T10:00:00.000Z", null, "2026-05-12", "2026-05-12T10:00:00.000Z");
});

describe("timeclock routes active restaurant context", () => {
  test("pending confirmations list only active restaurant clocks", async () => {
    const res = await app.request("/timeclock/pending-confirmations", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["clock-a2"]);
    expect(body.data[0].userName).toBe("Worker A2");
  });

  test("confirm cannot touch legacy restaurant clock", async () => {
    const legacy = await app.request("/timeclock/clock-a1/confirm", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/timeclock/clock-a2/confirm", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(active.status).toBe(200);

    const rows = rawDb.query("SELECT id, admin_confirmed_by FROM time_clocks ORDER BY id").all();
    expect(rows).toEqual([
      { id: "clock-a1", admin_confirmed_by: null },
      { id: "clock-a2", admin_confirmed_by: "admin-a" },
    ]);
  });

  test("tap-in confirmation notifies active restaurant admin membership", async () => {
    rawDb.prepare("UPDATE restaurants SET tap_in_out_admin_confirmation = 1 WHERE id = ?").run("a2");
    rawDb.prepare("DELETE FROM time_clocks WHERE user_id = ?").run("worker-a2");

    const res = await app.request("/timeclock/tap-in", {
      method: "POST",
      headers: { cookie: "session=session-worker-a2", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const notification = rawDb.query(`
      SELECT recipient_id, type, status, message
      FROM notifications
      WHERE type = 'time_clock_confirm'
    `).get() as any;
    expect(notification).toMatchObject({
      recipient_id: "admin-a",
      type: "time_clock_confirm",
      status: "failed",
    });
    expect(notification.message.startsWith("*Beta*\nWorker A2 a pointé son arrivée")).toBe(true);
  });

  test("tap-out confirmation also carries active restaurant context", async () => {
    rawDb.prepare("UPDATE restaurants SET tap_in_out_admin_confirmation = 1 WHERE id = ?").run("a2");

    const res = await app.request("/timeclock/tap-out", {
      method: "POST",
      headers: { cookie: "session=session-worker-a2" },
    });

    expect(res.status).toBe(200);
    const notification = rawDb.query(`
      SELECT recipient_id, type, status, message
      FROM notifications
      WHERE type = 'time_clock_confirm'
    `).get() as any;
    expect(notification).toMatchObject({
      recipient_id: "admin-a",
      type: "time_clock_confirm",
      status: "failed",
    });
    expect(notification.message.startsWith("*Beta*\nWorker A2 a pointé son départ")).toBe(true);
  });
});
