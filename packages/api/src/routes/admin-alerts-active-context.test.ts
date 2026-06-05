import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-admin-alerts-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { adminAlertsRoutes } = await import("./admin-alerts.js");

const app = new Hono();
app.route("/admin-alerts", adminAlertsRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS admin_alerts;
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

    CREATE TABLE admin_alerts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      action_url TEXT,
      worker_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      seen_at TEXT
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
    INSERT INTO admin_alerts (id, restaurant_id, recipient_id, type, title, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("alert-a1", "a1", "admin-a", "dossier", "A1", "Alpha", "2026-05-01T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO admin_alerts (id, restaurant_id, recipient_id, type, title, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("alert-a2", "a2", "admin-a", "dossier", "A2", "Beta", "2026-05-02T00:00:00.000Z");
});

describe("admin alert routes active restaurant context", () => {
  test("GET /admin-alerts lists only active restaurant alerts", async () => {
    const res = await app.request("/admin-alerts", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["alert-a2"]);
  });

  test("mark-seen cannot mark sibling restaurant alerts", async () => {
    const res = await app.request("/admin-alerts/mark-seen", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["alert-a1", "alert-a2"] }),
    });

    expect(res.status).toBe(200);
    const rows = rawDb.query("SELECT id, seen_at IS NOT NULL AS seen FROM admin_alerts ORDER BY id").all();
    expect(rows).toEqual([
      { id: "alert-a1", seen: 0 },
      { id: "alert-a2", seen: 1 },
    ]);
  });
});
