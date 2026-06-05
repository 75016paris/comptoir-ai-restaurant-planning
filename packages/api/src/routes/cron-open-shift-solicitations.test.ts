import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-cron-open-shifts-test-")), "test.db");
const previousCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "cron-secret";
delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { cronRoutes } = await import("./cron.js");

const app = new Hono();
app.route("/cron", cronRoutes);

afterAll(() => {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
});

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  createSchema();
  rawDb.prepare(`
    INSERT INTO restaurants (id, name, timezone, status, subscription_status, overtime_weekly_cap, cache_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("resto-1", "Resto", "Europe/Paris", "active", "active", 48, 0);
  insertUser("admin-1", "Admin One", "admin@example.com", "+33600000001", "admin", 1, []);
  insertUser("worker-1", "Worker One", "worker@example.com", "+33600000002", "floor", 1, []);
});

describe("cron open-shift solicitations", () => {
  test("rejects when cron secret is not configured", async () => {
    delete process.env.CRON_SECRET;

    const res = await app.request("/cron/open-shift-solicitations", {
      method: "POST",
      headers: { "X-Cron-Secret": "cron-secret" },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "cron_not_configured" });
  });

  test("rejects invalid cron secrets", async () => {
    const res = await app.request("/cron/open-shift-solicitations", {
      method: "POST",
      headers: { "X-Cron-Secret": "wrong-secret" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("returns processor counts and ignores already closed shifts", async () => {
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "send-live-candidate",
      "resto-1",
      "admin-1",
      "2099-05-04",
      "10:00",
      "14:00",
      "floor",
      JSON.stringify(["worker-1"]),
      "2099-05-04T10:00:00",
    );
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "done-no-candidates",
      "resto-1",
      "admin-1",
      "2099-05-04",
      "15:00",
      "18:00",
      "floor",
      JSON.stringify([]),
      "2099-05-04T15:00:00",
    );
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "claimed-ignored",
      "resto-1",
      "admin-1",
      "2099-05-04",
      "19:00",
      "22:00",
      "floor",
      JSON.stringify(["worker-1"]),
      "claimed",
      "2099-05-04T19:00:00",
    );

    const res = await app.request("/cron/open-shift-solicitations", {
      method: "POST",
      headers: { "X-Cron-Secret": "cron-secret" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, waiting: 0, done: 1 });
    const shifts = rawDb.query(`
      SELECT id, status, solicited_candidate_ids AS solicitedCandidateIds
      FROM open_shifts
      ORDER BY id
    `).all() as Array<{ id: string; status: string; solicitedCandidateIds: string }>;
    expect(shifts).toContainEqual({ id: "send-live-candidate", status: "open", solicitedCandidateIds: JSON.stringify(["worker-1"]) });
    expect(shifts).toContainEqual({ id: "done-no-candidates", status: "expired", solicitedCandidateIds: "[]" });
    expect(shifts).toContainEqual({ id: "claimed-ignored", status: "claimed", solicitedCandidateIds: "[]" });

    const cronRun = rawDb.query("SELECT job_name AS jobName, status, result FROM cron_runs").get() as any;
    expect(cronRun).toEqual({
      jobName: "open-shift-solicitations",
      status: "ok",
      result: JSON.stringify({ sent: 1, waiting: 0, done: 1 }),
    });
  });
});

function insertUser(id: string, name: string, email: string, phone: string, role: string, priority: number, subRoles: string[]) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions, priority, sub_roles, contract_hours
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
  `).run(id, name, email, phone, role, "resto-1", priority, JSON.stringify(subRoles), 35);
}

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS cron_runs;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS open_shifts;
    DROP TABLE IF EXISTS published_weeks;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS holiday_requests;
    DROP TABLE IF EXISTS worker_availability;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS worker_preferred_schedule;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    PRAGMA foreign_keys = ON;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'active',
      subscription_status TEXT NOT NULL DEFAULT 'active',
      overtime_weekly_cap INTEGER NOT NULL DEFAULT 48,
      cache_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER DEFAULT 35,
      max_weekly_hours INTEGER
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
      source TEXT NOT NULL DEFAULT 'manual',
      filled_as TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE TABLE holiday_requests (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, start_date TEXT, end_date TEXT, status TEXT);
    CREATE TABLE worker_availability (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, midi INTEGER, soir INTEGER, zones TEXT DEFAULT '{}');
    CREATE TABLE worker_restrictions (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, start_time TEXT, end_time TEXT, reason TEXT, effective_from TEXT, effective_until TEXT);
    CREATE TABLE worker_preferred_schedule (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, midi INTEGER, soir INTEGER, zones TEXT DEFAULT '{}');
    CREATE TABLE published_weeks (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, week_date TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT (datetime('now')));
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
    CREATE TABLE cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER,
      error TEXT,
      result TEXT
    );
  `);
}
