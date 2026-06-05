import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-email-recipients-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { emailRecipientRoutes } = await import("./email-recipients.js");

const app = new Hono();
app.route("/email-recipients", emailRecipientRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS email_recipients;
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

    CREATE TABLE email_recipients (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      label TEXT NOT NULL,
      email TEXT NOT NULL,
      send_monthly_digest INTEGER NOT NULL DEFAULT 0,
      send_leave_alerts INTEGER NOT NULL DEFAULT 0,
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
    INSERT INTO email_recipients (
      id, restaurant_id, label, email, send_monthly_digest, send_leave_alerts, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("recipient-a1", "a1", "A1 accountant", "a1@example.com", 1, 0, "2026-05-01T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO email_recipients (
      id, restaurant_id, label, email, send_monthly_digest, send_leave_alerts, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("recipient-a2", "a2", "A2 accountant", "a2@example.com", 1, 0, "2026-05-02T00:00:00.000Z");
});

describe("email recipient routes active restaurant context", () => {
  test("GET /email-recipients lists only active restaurant recipients", async () => {
    const res = await app.request("/email-recipients", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((row: any) => row.id)).toEqual(["recipient-a2"]);
  });

  test("mutations are scoped to the active restaurant", async () => {
    const updateSibling = await app.request("/email-recipients/recipient-a1", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ label: "Wrong scope" }),
    });
    expect(updateSibling.status).toBe(404);

    const created = await app.request("/email-recipients", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ label: "New", email: "new@example.com", sendMonthlyDigest: true }),
    });
    expect(created.status).toBe(201);

    const rows = rawDb.query("SELECT restaurant_id AS restaurantId, label FROM email_recipients ORDER BY label").all();
    expect(rows).toContainEqual({ restaurantId: "a2", label: "New" });
    expect(rows).not.toContainEqual({ restaurantId: "a1", label: "Wrong scope" });
  });
});
