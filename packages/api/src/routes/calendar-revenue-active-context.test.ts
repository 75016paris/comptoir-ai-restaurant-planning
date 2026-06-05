import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-calendar-revenue-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { calendarRoutes } = await import("./calendar.js");
const { revenueRoutes } = await import("./revenue.js");

const app = new Hono();
app.route("/calendar", calendarRoutes);
app.route("/revenue", revenueRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS daily_revenue;
    DROP TABLE IF EXISTS calendar_events;
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

    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      end_date TEXT,
      name TEXT NOT NULL,
      zone TEXT,
      year INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE daily_revenue (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      notes TEXT,
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
    INSERT INTO calendar_events (id, restaurant_id, type, date, end_date, name, zone, year)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("cal-a1", "a1", "public_holiday", "2026-05-01", null, "A1 holiday", "metropole", 2026);
  rawDb.prepare(`
    INSERT INTO calendar_events (id, restaurant_id, type, date, end_date, name, zone, year)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("cal-a2", "a2", "public_holiday", "2026-05-01", null, "A2 holiday", "metropole", 2026);

  rawDb.prepare("INSERT INTO daily_revenue (id, restaurant_id, date, amount, notes) VALUES (?, ?, ?, ?, ?)")
    .run("rev-a1", "a1", "2026-05-12", 10000, "A1");
  rawDb.prepare("INSERT INTO daily_revenue (id, restaurant_id, date, amount, notes) VALUES (?, ?, ?, ?, ?)")
    .run("rev-a2", "a2", "2026-05-12", 20000, "A2");
});

describe("calendar and revenue routes active restaurant context", () => {
  test("GET /calendar reads active restaurant events", async () => {
    const res = await app.request("/calendar?from=2026-05-01&to=2026-05-01", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ type: "public_holiday", date: "2026-05-01", endDate: null, name: "A2 holiday" }],
    });
  });

  test("GET and POST /revenue use active restaurant", async () => {
    const list = await app.request("/revenue?from=2026-05-12&to=2026-05-12", {
      headers: { cookie: "session=session-a" },
    });
    expect(list.status).toBe(200);
    expect((await list.json()).data.map((row: any) => row.id)).toEqual(["rev-a2"]);

    const post = await app.request("/revenue", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-05-12", amount: 25000, notes: "Updated A2" }),
    });
    expect(post.status).toBe(201);

    const rows = rawDb.query("SELECT restaurant_id, amount, notes FROM daily_revenue ORDER BY restaurant_id").all();
    expect(rows).toEqual([
      { restaurant_id: "a1", amount: 10000, notes: "A1" },
      { restaurant_id: "a2", amount: 25000, notes: "Updated A2" },
    ]);
  });
});
