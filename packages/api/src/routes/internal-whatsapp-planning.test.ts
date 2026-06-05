import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-planning-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS audit_logs;
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
    cache_version INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    contract_hours INTEGER,
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
    status TEXT NOT NULL DEFAULT 'scheduled',
    source TEXT NOT NULL DEFAULT 'manual',
    filled_as TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE published_weeks (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    week_date TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function insertUser(id: string, role: string, restaurantId = "resto-1", permissions: Record<string, boolean> | null = null) {
  rawDb.prepare(`
    INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0)
  `).run(id, `User ${id}`, `${id}@example.com`, `+336${id.replace(/\D/g, "").padStart(8, "0")}`, role, restaurantId, permissions ? JSON.stringify(permissions) : null);
}

function insertService(id: string, workerId = "worker-1", restaurantId = "resto-1") {
  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, workerId, restaurantId, "2026-05-04", "10:00", "14:00", "floor", "scheduled", "manual");
}

beforeEach(() => {
  process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status, cache_version) VALUES (?, ?, ?, ?, ?, ?)`).run("resto-1", "Resto 1", "Europe/Paris", "active", "active", 0);
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status, cache_version) VALUES (?, ?, ?, ?, ?, ?)`).run("resto-2", "Resto 2", "Europe/Paris", "active", "active", 0);
  insertUser("admin-1", "admin");
  insertUser("manager-denied", "manager", "resto-1", { PLANNING_EDIT: false, PUBLISH_WEEK: false });
  insertUser("worker-1", "floor");
  insertUser("worker-foreign", "floor", "resto-2");
});

describe("internal WhatsApp planning mutations", () => {
  test("admin can add a service with bot audit source", async () => {
    const res = await app.request("/internal/whatsapp/planning/services", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ workerId: "worker-1", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor", zone: "Midi" }),
    });

    expect(res.status).toBe(201);
    const service = rawDb.query(`SELECT worker_id, status FROM services WHERE worker_id = 'worker-1'`).get() as any;
    expect(service.status).toBe("scheduled");
    const audit = rawDb.query(`SELECT source, action FROM audit_logs WHERE table_name = 'services'`).get() as any;
    expect(audit).toEqual({ source: "bot:admin", action: "insert" });
    const cache = rawDb.query(`SELECT cache_version FROM restaurants WHERE id = 'resto-1'`).get() as any;
    expect(cache.cache_version).toBe(1);
  });

  test("manager lacking PLANNING_EDIT cannot add a service", async () => {
    const res = await app.request("/internal/whatsapp/planning/services", {
      method: "POST",
      headers: authHeaders("manager-denied"),
      body: JSON.stringify({ workerId: "worker-1", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }),
    });

    expect(res.status).toBe(403);
  });

  test("foreign worker is rejected on add", async () => {
    const res = await app.request("/internal/whatsapp/planning/services", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ workerId: "worker-foreign", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
  });

  test("admin can cancel a service", async () => {
    insertService("svc-1");

    const res = await app.request("/internal/whatsapp/planning/services/svc-1/cancel", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ zone: "Midi" }),
    });

    expect(res.status).toBe(200);
    const row = rawDb.query(`SELECT status FROM services WHERE id = 'svc-1'`).get() as any;
    expect(row.status).toBe("cancelled");
    const audit = rawDb.query(`SELECT source, action FROM audit_logs WHERE row_id = 'svc-1'`).get() as any;
    expect(audit).toEqual({ source: "bot:admin", action: "delete" });
  });

  test("admin can publish a week", async () => {
    insertService("svc-1");

    const res = await app.request("/internal/whatsapp/planning/weeks/2026-05-04/publish", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const published = rawDb.query(`SELECT week_date FROM published_weeks WHERE restaurant_id = 'resto-1'`).get() as any;
    expect(published.week_date).toBe("2026-05-04");
    const audit = rawDb.query(`SELECT source, table_name FROM audit_logs WHERE table_name = 'published_weeks'`).get() as any;
    expect(audit).toEqual({ source: "bot:admin", table_name: "published_weeks" });
  });
});
