import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-doc-atomicity-test-")), "test.db");
process.env.STORAGE_PROVIDER = "sqlite";

const { rawDb } = await import("../db/connection.js");
const { resetStorageForTests } = await import("../services/storage.js");
const { holidayRoutes } = await import("./holidays.js");
const { replacementRoutes } = await import("./replacements.js");

const RESTO_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const WORKER_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_ID = "00000000-0000-4000-8000-000000000004";
const SERVICE_ID = "00000000-0000-4000-8000-000000000005";
const SESSION_ID = "session-doc-atomicity";

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS documents;
  DROP TABLE IF EXISTS replacement_requests;
  DROP TABLE IF EXISTS services;
  DROP TABLE IF EXISTS holiday_requests;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  PRAGMA foreign_keys = ON;
  CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', status TEXT NOT NULL DEFAULT 'demo', subscription_status TEXT NOT NULL DEFAULT 'active', medical_mode INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT 'x', role TEXT NOT NULL, restaurant_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, permissions TEXT, must_change_password INTEGER NOT NULL DEFAULT 0, user_notice_version TEXT, user_notice_accepted_at TEXT, whatsapp_opt_in INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 1, sub_roles TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE holiday_requests (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT, medical INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT 'worker', reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE services (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', source TEXT NOT NULL DEFAULT 'manual', filled_as TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE replacement_requests (id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, requester_service_id TEXT NOT NULL, target_id TEXT, restaurant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_admin_decision', message TEXT, responded_at TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), candidate_ids TEXT, candidate_scores TEXT, admin_notified_at TEXT, worker_notified_at TEXT, escalation_count INTEGER NOT NULL DEFAULT 0, rejected_candidate_ids TEXT NOT NULL DEFAULT '[]', medical INTEGER NOT NULL DEFAULT 0, itt_reminder_sent_at TEXT);
  CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, holiday_request_id TEXT, replacement_request_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, storage_provider TEXT, storage_key TEXT, storage_status TEXT NOT NULL DEFAULT 'ready', uploaded_by TEXT NOT NULL, requirement_key TEXT, issued_at TEXT, expires_at TEXT, signed_at TEXT, reviewed_at TEXT, reviewed_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, changes TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, type TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', scheduled_for TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const app = new Hono();
app.route("/holidays", holidayRoutes);
app.route("/services/replacement", replacementRoutes);

function authHeaders() {
  return { "Content-Type": "application/json", Cookie: `session=${SESSION_ID}` };
}

function seedBase() {
  resetSqliteTables(rawDb, ["notifications", "audit_logs", "documents", "replacement_requests", "services", "holiday_requests", "sessions", "users", "restaurants"]);
  resetStorageForTests();
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status, medical_mode) VALUES (?, ?, ?, ?, ?, ?)`).run(RESTO_ID, "Resto", "Europe/Paris", "demo", "active", 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, password_hash, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`).run(ADMIN_ID, "Admin", "admin@example.test", "+33600000001", "x", "admin", RESTO_ID);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, password_hash, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`).run(WORKER_ID, "Worker", "worker@example.test", "+33600000002", "x", "floor", RESTO_ID);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, password_hash, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`).run(TARGET_ID, "Target", "target@example.test", "+33600000003", "x", "floor", RESTO_ID);
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(SESSION_ID, ADMIN_ID, "2099-01-01T00:00:00.000Z");
  rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(SERVICE_ID, WORKER_ID, RESTO_ID, "2099-05-10", "10:00", "14:00", "floor", "scheduled");
}

beforeEach(seedBase);

describe("document commit atomicity", () => {
  test("failed holiday document commit does not create the holiday request", async () => {
    const res = await app.request("/holidays", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        workerId: WORKER_ID,
        startDate: "2099-06-01",
        endDate: "2099-06-02",
        medical: true,
        documents: [{ name: "ITT", filename: "itt.pdf", mimeType: "application/pdf", size: 12, storageKey: "pending/itt.pdf" }],
      }),
    });

    expect(res.status).toBe(503);
    expect(rawDb.query(`SELECT COUNT(*) AS count FROM holiday_requests`).get()).toEqual({ count: 0 });
  });

  test("failed replacement document commit does not create the replacement request", async () => {
    const res = await app.request("/services/replacement/request", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        requesterServiceId: SERVICE_ID,
        targetId: TARGET_ID,
        medical: true,
        documents: [{ name: "ITT", filename: "itt.pdf", mimeType: "application/pdf", size: 12, storageKey: "pending/itt.pdf" }],
      }),
    });

    expect(res.status).toBe(503);
    expect(rawDb.query(`SELECT COUNT(*) AS count FROM replacement_requests`).get()).toEqual({ count: 0 });
  });
});
