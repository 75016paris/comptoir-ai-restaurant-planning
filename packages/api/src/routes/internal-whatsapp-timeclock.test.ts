import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-timeclock-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS time_clocks;
  DROP TABLE IF EXISTS published_weeks;
  DROP TABLE IF EXISTS services;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  PRAGMA foreign_keys = ON;

  CREATE TABLE restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
    status TEXT NOT NULL DEFAULT 'active',
    subscription_status TEXT NOT NULL DEFAULT 'active',
    tap_in_out_enabled INTEGER NOT NULL DEFAULT 1,
    tap_in_out_admin_confirmation INTEGER NOT NULL DEFAULT 0,
    tap_in_out_mode TEXT NOT NULL DEFAULT 'lateness_only',
    tap_in_counts_as_hours INTEGER NOT NULL DEFAULT 0
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
    must_change_password INTEGER NOT NULL DEFAULT 0
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
  CREATE TABLE published_weeks (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    week_date TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
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

const app = new Hono();
app.route("/internal/whatsapp", internalWhatsappRoutes);

function authHeaders(userId: string) {
  return {
    "Content-Type": "application/json",
    "X-WhatsApp-Internal-Secret": "test-secret",
    "X-Comptoir-User-Id": userId,
  };
}

beforeEach(() => {
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status, tap_in_out_enabled, tap_in_out_admin_confirmation, tap_in_out_mode, tap_in_counts_as_hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("resto-1", "Resto", "Europe/Paris", "active", "active", 1, 0, "lateness_only", 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0)`)
    .run("worker-1", "Worker One", "w@example.com", "+33600000001", "floor", "resto-1", null);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0)`)
    .run("admin-1", "Admin One", "a@example.com", "+33600000002", "admin", "resto-1", null);
  rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("svc-1", "worker-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
  rawDb.prepare(`INSERT INTO published_weeks (id, restaurant_id, week_date) VALUES (?, ?, ?)`).run("pub-1", "resto-1", "2026-05-04");
});

describe("internal WhatsApp timeclock and own hours", () => {
  test("worker can fetch own hours for a published month", async () => {
    const res = await app.request("/internal/whatsapp/me/hours?month=2026-05", { headers: authHeaders("worker-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.serviceCount).toBe(1);
    expect(json.data.totalHours).toBe(4);
  });

  test("worker can clock in and audit source is bot:worker", async () => {
    const res = await app.request("/internal/whatsapp/me/clock-in", {
      method: "POST",
      headers: authHeaders("worker-1"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const clock = rawDb.query(`SELECT user_id, tap_out FROM time_clocks WHERE user_id = 'worker-1'`).get() as any;
    expect(clock.user_id).toBe("worker-1");
    expect(clock.tap_out).toBeNull();
    const audit = rawDb.query(`SELECT source, table_name FROM audit_logs WHERE table_name = 'time_clocks'`).get() as any;
    expect(audit).toEqual({ source: "bot:worker", table_name: "time_clocks" });
  });

  test("second clock in is rejected", async () => {
    await app.request("/internal/whatsapp/me/clock-in", { method: "POST", headers: authHeaders("worker-1"), body: JSON.stringify({}) });
    const res = await app.request("/internal/whatsapp/me/clock-in", { method: "POST", headers: authHeaders("worker-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Tu es déjà pointé(e). Dis 'pointer sortie' pour terminer." });
  });

  test("worker can clock out", async () => {
    await app.request("/internal/whatsapp/me/clock-in", { method: "POST", headers: authHeaders("worker-1"), body: JSON.stringify({}) });
    const res = await app.request("/internal/whatsapp/me/clock-out", { method: "POST", headers: authHeaders("worker-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(200);
    const clock = rawDb.query(`SELECT tap_out FROM time_clocks WHERE user_id = 'worker-1'`).get() as any;
    expect(clock.tap_out).toBeTruthy();
  });

  test("admin can confirm a pending timeclock after notification", async () => {
    rawDb.prepare(`UPDATE restaurants SET tap_in_out_admin_confirmation = 1 WHERE id = ?`).run("resto-1");
    await app.request("/internal/whatsapp/me/clock-in", { method: "POST", headers: authHeaders("worker-1"), body: JSON.stringify({}) });

    const pending = await app.request("/internal/whatsapp/timeclock/pending-confirmations", { headers: authHeaders("admin-1") });
    expect(pending.status).toBe(200);
    expect((await pending.json()).data.pending).toHaveLength(1);

    const confirm = await app.request("/internal/whatsapp/timeclock/confirm-latest", { method: "POST", headers: authHeaders("admin-1"), body: JSON.stringify({}) });
    expect(confirm.status).toBe(200);
    const clock = rawDb.query(`SELECT admin_confirmed_by, admin_confirmed_at FROM time_clocks WHERE user_id = 'worker-1'`).get() as any;
    expect(clock.admin_confirmed_by).toBe("admin-1");
    expect(clock.admin_confirmed_at).toBeTruthy();
  });

  test("disabled restaurant rejects clock in", async () => {
    rawDb.prepare(`UPDATE restaurants SET tap_in_out_enabled = 0 WHERE id = ?`).run("resto-1");

    const res = await app.request("/internal/whatsapp/me/clock-in", { method: "POST", headers: authHeaders("worker-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Le pointage n'est pas activé pour ton restaurant." });
  });
});
