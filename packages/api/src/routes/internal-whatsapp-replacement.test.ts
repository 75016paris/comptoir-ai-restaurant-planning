import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-repl-test-")), "test.db");
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
  DROP TABLE IF EXISTS service_templates;
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
    subscription_status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT DEFAULT '',
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

  CREATE TABLE service_templates (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    zone TEXT NOT NULL,
    start_time TEXT NOT NULL
  );

  CREATE TABLE holiday_requests (
    id TEXT PRIMARY KEY,
    worker_id TEXT,
    restaurant_id TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT
  );

  CREATE TABLE worker_availability (
    id TEXT PRIMARY KEY,
    worker_id TEXT,
    restaurant_id TEXT,
    day_of_week INTEGER,
    midi INTEGER,
    soir INTEGER,
    zones TEXT DEFAULT '{}'
  );

  CREATE TABLE worker_restrictions (
    id TEXT PRIMARY KEY,
    worker_id TEXT,
    restaurant_id TEXT,
    day_of_week INTEGER,
    start_time TEXT,
    end_time TEXT,
    reason TEXT,
    effective_from TEXT,
    effective_until TEXT
  );

  CREATE TABLE worker_preferred_schedule (
    id TEXT PRIMARY KEY,
    worker_id TEXT,
    restaurant_id TEXT,
    day_of_week INTEGER,
    midi INTEGER,
    soir INTEGER,
    zones TEXT DEFAULT '{}'
  );

  CREATE TABLE replacement_requests (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    requester_service_id TEXT NOT NULL,
    target_id TEXT,
    restaurant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    responded_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    candidate_ids TEXT,
    candidate_scores TEXT,
    admin_notified_at TEXT,
    worker_notified_at TEXT,
    escalation_count INTEGER NOT NULL DEFAULT 0,
    rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
    medical INTEGER NOT NULL DEFAULT 0,
    itt_reminder_sent_at TEXT
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

function seedReplacement(status = "awaiting_admin_decision", restaurantId = "resto-1") {
  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`svc-${restaurantId}`, `requester-${restaurantId}`, restaurantId, "2026-05-04", "10:00", "14:00", "floor", "scheduled", "manual");
  rawDb.prepare(`
    INSERT INTO replacement_requests (
      id, requester_id, requester_service_id, target_id, restaurant_id, status, message, expires_at,
      candidate_ids, candidate_scores, rejected_candidate_ids
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    `repl-${restaurantId}`,
    `requester-${restaurantId}`,
    `svc-${restaurantId}`,
    restaurantId,
    status,
    "2026-05-11T00:00:00.000Z",
    JSON.stringify([`candidate-${restaurantId}`]),
    JSON.stringify({ [`candidate-${restaurantId}`]: 100 }),
    JSON.stringify([]),
  );
}

beforeEach(() => {
  process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?)`).run("resto-1", "Resto 1", "Europe/Paris", "active", "active");
  rawDb.prepare(`INSERT INTO restaurants (id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?)`).run("resto-2", "Resto 2", "Europe/Paris", "active", "active");

  insertUser("admin-1", "admin");
  insertUser("manager-denied", "manager", "resto-1", { REPLACEMENT_APPROVE: false });
  insertUser("worker-1", "floor");
  insertUser("requester-resto-1", "floor");
  insertUser("candidate-resto-1", "floor");
  insertUser("admin-2", "admin", "resto-2");
  insertUser("requester-resto-2", "floor", "resto-2");
  insertUser("candidate-resto-2", "floor", "resto-2");
  seedReplacement("awaiting_admin_decision", "resto-1");
  seedReplacement("awaiting_admin_decision", "resto-2");
});

describe("internal WhatsApp replacement review mutation", () => {
  test("admin can pick a candidate and writes bot audit source", async () => {
    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "pick", candidateId: "candidate-resto-1" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ decision: "pick", pickedName: "User candidate-resto-1", status: "awaiting_worker_reply" });

    const row = rawDb.query(`SELECT status, target_id, worker_notified_at FROM replacement_requests WHERE id = 'repl-resto-1'`).get() as any;
    expect(row.status).toBe("awaiting_worker_reply");
    expect(row.target_id).toBe("candidate-resto-1");
    expect(row.worker_notified_at).toBeTruthy();

    const audit = rawDb.query(`SELECT source, summary FROM audit_logs WHERE row_id = 'repl-resto-1'`).get() as any;
    expect(audit.source).toBe("bot:admin");
    expect(audit.summary).toContain("candidate-resto-1");
  });

  test("admin cannot pick a candidate who is no longer eligible", async () => {
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run("candidate-resto-1");

    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "pick", candidateId: "candidate-resto-1" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Candidat non disponible pour cette demande" });
    const row = rawDb.query(`SELECT status, target_id, worker_notified_at FROM replacement_requests WHERE id = 'repl-resto-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_admin_decision", target_id: null, worker_notified_at: null });
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
  });

  test("admin broadcast skips stale candidates and fails closed when none remain", async () => {
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run("candidate-resto-1");

    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "broadcast" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Aucun candidat disponible pour broadcaster" });
    const row = rawDb.query(`SELECT status, target_id, worker_notified_at FROM replacement_requests WHERE id = 'repl-resto-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_admin_decision", target_id: null, worker_notified_at: null });
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
  });

  test("admin broadcast persists only live candidate ids", async () => {
    insertUser("candidate-live", "floor");
    rawDb.prepare("UPDATE replacement_requests SET candidate_ids = ? WHERE id = ?")
      .run(JSON.stringify(["candidate-resto-1", "candidate-live"]), "repl-resto-1");
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run("candidate-resto-1");

    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "broadcast" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { decision: "broadcast", status: "awaiting_worker_reply", candidateCount: 1 } });
    const row = rawDb.query(`SELECT status, target_id, candidate_ids FROM replacement_requests WHERE id = 'repl-resto-1'`).get() as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null, candidate_ids: JSON.stringify(["candidate-live"]) });
  });

  test("review preparation labels coupure only from active restaurant visible services", async () => {
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("foreign-sibling", "requester-resto-1", "resto-2", "2026-05-04", "18:00", "22:00", "floor", "scheduled", "manual");

    const res = await app.request("/internal/whatsapp/replacements/review/prepare", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "broadcast" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        status: "broadcast_ready",
        replacementId: "repl-resto-1",
        svcLabel: "2026-05-04 (10:00-14:00)",
      },
    });
  });

  test("manager lacking REPLACEMENT_APPROVE is denied", async () => {
    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("manager-denied"),
      body: JSON.stringify({ decision: "refuse" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Seul le gérant peut arbitrer un remplacement." });
  });

  test("worker is denied", async () => {
    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("worker-1"),
      body: JSON.stringify({ decision: "refuse" }),
    });

    expect(res.status).toBe(403);
  });

  test("foreign restaurant replacement does not leak", async () => {
    const res = await app.request("/internal/whatsapp/replacements/repl-resto-2/review", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "refuse" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Remplacement introuvable" });
  });

  test("invalid state transition fails", async () => {
    rawDb.prepare(`UPDATE replacement_requests SET status = ? WHERE id = ?`).run("awaiting_worker_reply", "repl-resto-1");

    const res = await app.request("/internal/whatsapp/replacements/repl-resto-1/review", {
      method: "POST",
      headers: authHeaders("admin-1"),
      body: JSON.stringify({ decision: "refuse" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Cette demande n'est plus en attente de décision" });
  });
});
