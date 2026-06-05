import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-services-delete-open-shifts-test-")), "test.db");

delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { OWNER_LEGAL_VERSIONS } = await import("../services/legal-acceptance.js");
const { serviceRoutes } = await import("./services.js");
const { scheduleRoutes } = await import("./schedule.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS legal_acceptances;
  DROP TABLE IF EXISTS open_shifts;
  DROP TABLE IF EXISTS replacement_requests;
  DROP TABLE IF EXISTS time_clocks;
  DROP TABLE IF EXISTS published_weeks;
  DROP TABLE IF EXISTS services;
  DROP TABLE IF EXISTS sessions;
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
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    active INTEGER NOT NULL DEFAULT 1,
    permissions TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    user_notice_version TEXT,
    user_notice_accepted_at TEXT,
    whatsapp_opt_in INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE services (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES users(id),
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
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

  CREATE TABLE time_clocks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    service_id TEXT REFERENCES services(id),
    tap_in TEXT NOT NULL,
    tap_out TEXT,
    date TEXT NOT NULL,
    admin_confirmed_at TEXT,
    admin_confirmed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE replacement_requests (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id),
    requester_service_id TEXT NOT NULL REFERENCES services(id),
    target_id TEXT REFERENCES users(id),
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    status TEXT NOT NULL DEFAULT 'awaiting_admin_decision',
    message TEXT,
    responded_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE open_shifts (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    created_by TEXT NOT NULL REFERENCES users(id),
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
    claimed_by TEXT REFERENCES users(id),
    claimed_at TEXT,
    service_id TEXT REFERENCES services(id),
    expires_at TEXT NOT NULL,
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

  CREATE TABLE legal_acceptances (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    acceptance_type TEXT NOT NULL,
    terms_version TEXT NOT NULL,
    dpa_version TEXT NOT NULL,
    privacy_version TEXT NOT NULL,
    subprocessors_version TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const app = new Hono();
app.route("/services", serviceRoutes);
app.route("/schedule", scheduleRoutes);

const authHeaders = { Cookie: "session=session-1" };

function insertService(id: string, date = "2026-05-12") {
  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source)
    VALUES (?, 'worker-1', 'resto-1', ?, '18:00', '23:30', 'floor', 'scheduled', 'manual')
  `).run(id, date);
}

function linkClaimedOpenShift(shiftId: string, serviceId: string, date = "2026-05-12") {
  rawDb.prepare(`
    INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, status, claimed_by, service_id, expires_at)
    VALUES (?, 'resto-1', 'admin-1', ?, '18:00', '23:30', 'floor', 'claimed', 'worker-1', ?, '2026-05-12T20:00:00')
  `).run(shiftId, date, serviceId);
}

beforeEach(() => {
  rawDb.exec("DELETE FROM audit_logs; DELETE FROM legal_acceptances; DELETE FROM open_shifts; DELETE FROM replacement_requests; DELETE FROM time_clocks; DELETE FROM published_weeks; DELETE FROM services; DELETE FROM sessions; DELETE FROM users; DELETE FROM restaurants;");
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status, cache_version) VALUES ('resto-1', 'Resto', 'Europe/Paris', 'active', 'active', 0)`).run();
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, must_change_password) VALUES ('admin-1', 'Admin One', 'admin@example.com', '+33600000001', 'admin', 'resto-1', 1, NULL, 0)`).run();
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, must_change_password) VALUES ('worker-1', 'Worker One', 'worker@example.com', '+33600000002', 'floor', 'resto-1', 1, NULL, 0)`).run();
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-1', 'admin-1', '2099-01-01T00:00:00.000Z')`).run();
  rawDb.prepare(`
    INSERT INTO legal_acceptances (id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version)
    VALUES ('legal-1', 'resto-1', 'admin-1', 'owner_terms', ?, ?, ?, ?)
  `).run(OWNER_LEGAL_VERSIONS.terms, OWNER_LEGAL_VERSIONS.dpa, OWNER_LEGAL_VERSIONS.privacy, OWNER_LEGAL_VERSIONS.subprocessors);
});

describe("dashboard service deletion with claimed open shifts", () => {
  test("DELETE /services/:id unlinks the claimed open shift before deleting the service", async () => {
    insertService("svc-1");
    linkClaimedOpenShift("open-1", "svc-1");

    const res = await app.request("/services/svc-1", { method: "DELETE", headers: authHeaders });

    expect(res.status).toBe(200);
    expect(rawDb.query(`SELECT id FROM services WHERE id = 'svc-1'`).get()).toBeNull();
    const openShift = rawDb.query(`SELECT status, service_id FROM open_shifts WHERE id = 'open-1'`).get() as any;
    expect(openShift).toEqual({ status: "cancelled", service_id: null });
  });

  test("DELETE /schedule/week unlinks claimed open shifts before wiping services", async () => {
    insertService("svc-1", "2026-05-12");
    insertService("svc-2", "2026-05-13");
    linkClaimedOpenShift("open-1", "svc-1", "2026-05-12");

    const res = await app.request("/schedule/week?date=2026-05-12", { method: "DELETE", headers: authHeaders });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: 2 } });
    expect(rawDb.query(`SELECT COUNT(*) AS count FROM services`).get()).toEqual({ count: 0 });
    const openShift = rawDb.query(`SELECT status, service_id FROM open_shifts WHERE id = 'open-1'`).get() as any;
    expect(openShift).toEqual({ status: "cancelled", service_id: null });
  });
});
