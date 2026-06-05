import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-worker-repl-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS replacement_requests;
  DROP TABLE IF EXISTS services;
  DROP TABLE IF EXISTS restaurant_memberships;
  DROP TABLE IF EXISTS holiday_requests;
  DROP TABLE IF EXISTS worker_availability;
  DROP TABLE IF EXISTS worker_restrictions;
  DROP TABLE IF EXISTS worker_preferred_schedule;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  PRAGMA foreign_keys = ON;
  CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', status TEXT NOT NULL DEFAULT 'active', subscription_status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, role TEXT NOT NULL, restaurant_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, permissions TEXT, must_change_password INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 1, sub_roles TEXT NOT NULL DEFAULT '[]', contract_hours INTEGER DEFAULT 35, max_weekly_hours INTEGER);
  CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, permissions TEXT, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (restaurant_id, user_id));
  CREATE TABLE services (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', updated_at TEXT);
  CREATE TABLE replacement_requests (id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, requester_service_id TEXT NOT NULL, target_id TEXT, restaurant_id TEXT NOT NULL, status TEXT NOT NULL, message TEXT, responded_at TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), candidate_ids TEXT, candidate_scores TEXT, admin_notified_at TEXT, worker_notified_at TEXT, escalation_count INTEGER NOT NULL DEFAULT 0, rejected_candidate_ids TEXT NOT NULL DEFAULT '[]', medical INTEGER NOT NULL DEFAULT 0, itt_reminder_sent_at TEXT);
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, changes TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, type TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', scheduled_for TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE holiday_requests (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, start_date TEXT, end_date TEXT, status TEXT);
  CREATE TABLE worker_availability (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, midi INTEGER, soir INTEGER, zones TEXT DEFAULT '{}');
  CREATE TABLE worker_restrictions (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, start_time TEXT, end_time TEXT, reason TEXT, effective_from TEXT, effective_until TEXT);
  CREATE TABLE worker_preferred_schedule (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, midi INTEGER, soir INTEGER, zones TEXT DEFAULT '{}');
`);

const app = new Hono();
app.route("/internal/whatsapp", internalWhatsappRoutes);
const headers = (userId: string) => ({ "Content-Type": "application/json", "X-WhatsApp-Internal-Secret": "test-secret", "X-Comptoir-User-Id": userId });

beforeEach(() => {
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?)`).run("resto-1", "Resto", "Europe/Paris", "active", "active");
  for (const [id, name, role] of [["worker-1", "Worker One", "floor"], ["candidate-1", "Candidate One", "floor"], ["admin-1", "Admin One", "admin"]]) {
    const legacyRestaurantId = id === "admin-1" ? "legacy-resto" : "resto-1";
    rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`).run(id, name, `${id}@x`, `+336${id.length}`, role, legacyRestaurantId);
    rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, 1)`).run("resto-1", id, role);
  }
  rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-1", "worker-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
});

describe("internal WhatsApp worker replacement endpoints", () => {
  test("worker can report unavailable", async () => {
    const res = await app.request("/internal/whatsapp/me/replacements/report-unavailable", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({ requesterServiceId: "svc-1", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }) });
    expect(res.status).toBe(201);
    const row = rawDb.query(`SELECT status, requester_id FROM replacement_requests`).get() as any;
    expect(row).toEqual({ status: "awaiting_admin_decision", requester_id: "worker-1" });
    const notification = rawDb.query(`SELECT recipient_id FROM notifications WHERE type='replacement_request'`).get() as any;
    expect(notification.recipient_id).toBe("admin-1");
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE table_name='replacement_requests'`).get() as any;
    expect(audit.source).toBe("bot:worker");
  });

  test("report unavailable derives replacement role from the stored service", async () => {
    rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`)
      .run("candidate-kitchen", "Candidate Kitchen", "candidate-kitchen@x", "+336999", "kitchen", "resto-1");
    rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, 1)`)
      .run("resto-1", "candidate-kitchen", "kitchen");

    const res = await app.request("/internal/whatsapp/me/replacements/report-unavailable", {
      method: "POST",
      headers: headers("worker-1"),
      body: JSON.stringify({ requesterServiceId: "svc-1", date: "2099-01-01", startTime: "00:00", endTime: "01:00", role: "kitchen" }),
    });

    expect(res.status).toBe(201);
    const row = rawDb.query(`SELECT candidate_ids FROM replacement_requests`).get() as any;
    const candidateIds = JSON.parse(row.candidate_ids);
    expect(candidateIds).toContain("candidate-1");
    expect(candidateIds).not.toContain("candidate-kitchen");
  });

  test("pending list returns sent requests", async () => {
    await app.request("/internal/whatsapp/me/replacements/report-unavailable", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({ requesterServiceId: "svc-1", date: "2026-05-04", startTime: "10:00", endTime: "14:00", role: "floor" }) });
    const res = await app.request("/internal/whatsapp/me/replacements/pending", { headers: headers("worker-1") });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.sent).toHaveLength(1);
  });

  test("pending list hides stale direct replacement offers", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/internal/whatsapp/me/replacements/pending", { headers: headers("candidate-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.received).toEqual([]);
  });

  test("pending list hides expired direct replacement offers", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2000-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/pending", { headers: headers("candidate-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.received).toEqual([]);
  });

  test("pending list hides stale broadcast replacement offers", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/internal/whatsapp/me/replacements/pending", { headers: headers("candidate-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.received).toEqual([]);
  });

  test("pending list hides expired broadcast replacement offers", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2000-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/pending", { headers: headers("candidate-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.received).toEqual([]);
  });

  test("pending list hides broadcast replacement offers already rejected by the worker", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify(["candidate-1"]));

    const res = await app.request("/internal/whatsapp/me/replacements/pending", { headers: headers("candidate-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.received).toEqual([]);
  });

  test("candidate cannot reject an expired direct replacement offer", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2000-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(410);
    const row = rawDb.query(`SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "expired", target_id: "candidate-1", rejected_candidate_ids: JSON.stringify([]) });
  });

  test("candidate cannot reject an expired broadcast replacement offer", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2000-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(410);
    const row = rawDb.query(`SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "expired", target_id: null, rejected_candidate_ids: JSON.stringify([]) });
  });

  test("candidate can accept replacement", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });
    expect(res.status).toBe(200);
    const svc = rawDb.query(`SELECT worker_id FROM services WHERE id='svc-1'`).get() as any;
    expect(svc.worker_id).toBe("candidate-1");
  });

  test("candidate accepts only same-day siblings matching an eligible role", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("svc-floor-sibling", "worker-1", "resto-1", "2026-05-04", "18:00", "22:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("svc-kitchen-sibling", "worker-1", "resto-1", "2026-05-04", "08:00", "10:00", "kitchen", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const services = rawDb.query(`SELECT id, worker_id FROM services WHERE id IN ('svc-1', 'svc-floor-sibling', 'svc-kitchen-sibling') ORDER BY id`).all() as any[];
    expect(services).toEqual([
      { id: "svc-1", worker_id: "candidate-1" },
      { id: "svc-floor-sibling", worker_id: "candidate-1" },
      { id: "svc-kitchen-sibling", worker_id: "worker-1" },
    ]);
  });

  test("candidate cannot accept a stale direct replacement offer", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(409);
    const svc = rawDb.query(`SELECT worker_id FROM services WHERE id='svc-1'`).get() as any;
    expect(svc.worker_id).toBe("worker-1");
    const row = rawDb.query(`SELECT status, target_id FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: "candidate-1" });
  });

  test("candidate cannot reject a stale direct replacement offer", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(409);
    const row = rawDb.query(`SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: "candidate-1", rejected_candidate_ids: JSON.stringify([]) });
  });

  test("candidate can accept a live broadcast when a stale direct offer also exists", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-direct", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-broadcast", "worker-1", "svc-2", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const services = rawDb.query(`SELECT id, worker_id FROM services WHERE id IN ('svc-1', 'svc-2') ORDER BY id`).all() as any[];
    expect(services).toEqual([
      { id: "svc-1", worker_id: "worker-1" },
      { id: "svc-2", worker_id: "candidate-1" },
    ]);
    const rows = rawDb.query(`SELECT id, status, target_id FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-broadcast", status: "accepted", target_id: "candidate-1" },
      { id: "repl-direct", status: "awaiting_worker_reply", target_id: "candidate-1" },
    ]);
  });

  test("candidate accepts the newest live direct offer instead of being blocked by a newer stale direct offer", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-live", "worker-1", "svc-2", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-stale", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const services = rawDb.query(`SELECT id, worker_id FROM services WHERE id IN ('svc-1', 'svc-2') ORDER BY id`).all() as any[];
    expect(services).toEqual([
      { id: "svc-1", worker_id: "worker-1" },
      { id: "svc-2", worker_id: "candidate-1" },
    ]);
    const rows = rawDb.query(`SELECT id, status, target_id FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-live", status: "accepted", target_id: "candidate-1" },
      { id: "repl-stale", status: "awaiting_worker_reply", target_id: "candidate-1" },
    ]);
  });

  test("candidate rejects the newest live direct offer instead of mutating a newer stale direct offer", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-live", "worker-1", "svc-2", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-stale", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(200);
    const rows = rawDb.query(`SELECT id, status, target_id, rejected_candidate_ids FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-live", status: "awaiting_admin_decision", target_id: null, rejected_candidate_ids: JSON.stringify(["candidate-1"]) },
      { id: "repl-stale", status: "awaiting_worker_reply", target_id: "candidate-1", rejected_candidate_ids: JSON.stringify([]) },
    ]);
  });

  test("candidate accepts a live direct offer instead of being blocked by a newer expired direct offer", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-live", "worker-1", "svc-2", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-expired", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2000-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const services = rawDb.query(`SELECT id, worker_id FROM services WHERE id IN ('svc-1', 'svc-2') ORDER BY id`).all() as any[];
    expect(services).toEqual([
      { id: "svc-1", worker_id: "worker-1" },
      { id: "svc-2", worker_id: "candidate-1" },
    ]);
    const rows = rawDb.query(`SELECT id, status, target_id FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-expired", status: "awaiting_worker_reply", target_id: "candidate-1" },
      { id: "repl-live", status: "accepted", target_id: "candidate-1" },
    ]);
  });

  test("candidate cannot accept a stale broadcast replacement offer", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(409);
    const svc = rawDb.query(`SELECT worker_id FROM services WHERE id='svc-1'`).get() as any;
    expect(svc.worker_id).toBe("worker-1");
    const row = rawDb.query(`SELECT status, target_id FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null });
  });

  test("candidate cannot reject a stale broadcast replacement offer", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(409);
    const row = rawDb.query(`SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify([]) });
  });

  test("candidate cannot accept a broadcast replacement offer already rejected by the worker", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify(["candidate-1"]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(404);
    const svc = rawDb.query(`SELECT worker_id FROM services WHERE id='svc-1'`).get() as any;
    expect(svc.worker_id).toBe("worker-1");
    const row = rawDb.query(`SELECT status, target_id FROM replacement_requests WHERE id='repl-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null });
  });

  test("candidate accepts the newest actionable broadcast instead of being blocked by an unrelated newer one", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-actionable", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-unrelated", "worker-1", "svc-2", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["someone-else"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const svc1 = rawDb.query(`SELECT worker_id FROM services WHERE id='svc-1'`).get() as any;
    expect(svc1.worker_id).toBe("candidate-1");
    const rows = rawDb.query(`SELECT id, status, target_id FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-actionable", status: "accepted", target_id: "candidate-1" },
      { id: "repl-unrelated", status: "awaiting_worker_reply", target_id: null },
    ]);
  });

  test("candidate accepts the newest live broadcast instead of being blocked by a newer stale broadcast", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-live", "worker-1", "svc-2", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-stale", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const services = rawDb.query(`SELECT id, worker_id FROM services WHERE id IN ('svc-1', 'svc-2') ORDER BY id`).all() as any[];
    expect(services).toEqual([
      { id: "svc-1", worker_id: "worker-1" },
      { id: "svc-2", worker_id: "candidate-1" },
    ]);
    const rows = rawDb.query(`SELECT id, status, target_id FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-live", status: "accepted", target_id: "candidate-1" },
      { id: "repl-stale", status: "awaiting_worker_reply", target_id: null },
    ]);
  });

  test("candidate rejects a live broadcast when a stale direct offer also exists", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-direct", "worker-1", "svc-1", "candidate-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-broadcast", "worker-1", "svc-2", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(200);
    const rows = rawDb.query(`SELECT id, status, target_id, rejected_candidate_ids FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-broadcast", status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify(["candidate-1"]) },
      { id: "repl-direct", status: "awaiting_worker_reply", target_id: "candidate-1", rejected_candidate_ids: JSON.stringify([]) },
    ]);
  });

  test("candidate rejects the newest live broadcast instead of mutating a newer stale broadcast", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("candidate-conflict", "candidate-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-live", "worker-1", "svc-2", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-stale", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "rejected" }) });

    expect(res.status).toBe(200);
    const rows = rawDb.query(`SELECT id, status, target_id, rejected_candidate_ids FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-live", status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify(["candidate-1"]) },
      { id: "repl-stale", status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify([]) },
    ]);
  });

  test("candidate accepts a live broadcast instead of being blocked by a newer expired broadcast", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("svc-2", "worker-1", "resto-1", "2026-05-05", "10:00", "14:00", "floor", "scheduled");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-live", "worker-1", "svc-2", "resto-1", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, created_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run("repl-expired", "worker-1", "svc-1", "resto-1", "awaiting_worker_reply", "2000-01-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", JSON.stringify(["candidate-1"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/me/replacements/respond", { method: "POST", headers: headers("candidate-1"), body: JSON.stringify({ decision: "accepted" }) });

    expect(res.status).toBe(200);
    const services = rawDb.query(`SELECT id, worker_id FROM services WHERE id IN ('svc-1', 'svc-2') ORDER BY id`).all() as any[];
    expect(services).toEqual([
      { id: "svc-1", worker_id: "worker-1" },
      { id: "svc-2", worker_id: "candidate-1" },
    ]);
    const rows = rawDb.query(`SELECT id, status, target_id FROM replacement_requests ORDER BY id`).all() as any[];
    expect(rows).toEqual([
      { id: "repl-expired", status: "awaiting_worker_reply", target_id: null },
      { id: "repl-live", status: "accepted", target_id: "candidate-1" },
    ]);
  });
});
