import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-audit-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { auditRoutes } = await import("./audit.js");

const app = new Hono();
app.route("/audit-logs", auditRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS audit_logs;
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
      created_at TEXT NOT NULL
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
    INSERT INTO audit_logs (
      id, restaurant_id, table_name, row_id, action, actor_id, actor_name, source, changes, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("audit-a1", "a1", "services", "service-a1", "insert", "admin-a", "Admin A", "dashboard", null, "A1", "2026-05-12T09:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO audit_logs (
      id, restaurant_id, table_name, row_id, action, actor_id, actor_name, source, changes, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("audit-a2", "a2", "services", "service-a2", "insert", "admin-a", "Admin A", "dashboard", '{"after":"a2"}', "A2", "2026-05-12T10:00:00.000Z");
});

describe("audit routes active restaurant context", () => {
  test("GET /audit-logs returns only active restaurant audit entries", async () => {
    const res = await app.request("/audit-logs", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{
        id: "audit-a2",
        tableName: "services",
        rowId: "service-a2",
        action: "insert",
        actorId: "admin-a",
        actorName: "Admin A",
        source: "dashboard",
        changes: { after: "a2" },
        summary: "A2",
        createdAt: "2026-05-12T10:00:00.000Z",
      }],
    });
  });
});
