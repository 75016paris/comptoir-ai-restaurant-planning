import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-notifications-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { notificationRoutes } = await import("./notifications.js");

const app = new Hono();
app.route("/notifications", notificationRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS notifications;
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
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "worker-a1", "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-a2", "floor", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO notifications (id, recipient_id, type, channel, message, status, scheduled_for, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("notif-a1", "worker-a1", "schedule_change", "whatsapp", "A1", "failed", "2026-05-12T09:00:00.000Z", "2026-05-12T09:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO notifications (id, recipient_id, type, channel, message, status, scheduled_for, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("notif-a2", "worker-a2", "schedule_change", "whatsapp", "A2", "failed", "2026-05-12T10:00:00.000Z", "2026-05-12T10:00:00.000Z");
});

describe("notification routes active restaurant context", () => {
  test("GET /notifications lists active restaurant recipient notifications for admin", async () => {
    const res = await app.request("/notifications", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["notif-a2"]);
    expect(body.data[0].recipientName).toBe("Worker A2");
  });

  test("retry cannot touch legacy restaurant notification", async () => {
    const legacy = await app.request("/notifications/notif-a1/retry", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/notifications/notif-a2/retry", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(active.status).toBe(200);

    const rows = rawDb.query("SELECT id, status FROM notifications ORDER BY id").all();
    expect(rows).toEqual([
      { id: "notif-a1", status: "failed" },
      { id: "notif-a2", status: "queued" },
    ]);
  });
});
