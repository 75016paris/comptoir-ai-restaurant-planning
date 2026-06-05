import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-holidays-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { holidayRoutes } = await import("./holidays.js");

const app = new Hono();
app.route("/holidays", holidayRoutes);

const workerA2Uuid = "44444444-4444-4444-8444-444444444444";
const sharedA1WorkerUuid = "55555555-5555-4555-8555-555555555555";

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS holiday_requests;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS worker_share_authorizations;
    DROP TABLE IF EXISTS worker_restaurant_profiles;
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
      onboarding_completed_at TEXT,
      medical_mode INTEGER NOT NULL DEFAULT 0,
      cache_version INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE worker_restaurant_profiles (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (restaurant_id, user_id)
    );

    CREATE TABLE worker_share_authorizations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      source_restaurant_id TEXT NOT NULL,
      target_restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      invited_by_user_id TEXT,
      worker_consented_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE holiday_requests (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      medical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'worker',
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      restaurant_id TEXT NOT NULL,
      holiday_request_id TEXT,
      name TEXT NOT NULL DEFAULT 'Doc',
      type TEXT NOT NULL DEFAULT 'medical',
      filename TEXT NOT NULL DEFAULT 'doc.pdf',
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      size INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL DEFAULT '',
      storage_provider TEXT,
      storage_key TEXT,
      storage_status TEXT NOT NULL DEFAULT 'ready',
      uploaded_by TEXT,
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
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workerA2Uuid, "Worker A2", "worker-a2@example.com", "floor", "a1", 1, null, 0);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sharedA1WorkerUuid, "Shared A1 Worker", "shared-a1@example.com", "floor", "a1", 1, null, 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", workerA2Uuid, "floor", null, 1);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", sharedA1WorkerUuid, "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", sharedA1WorkerUuid, "floor", null, 1);
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("a2", sharedA1WorkerUuid, 1, "[]", 35, 39, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-a1-a2", "owner-a", "a1", "a2", sharedA1WorkerUuid, "floor", "accepted", "admin-a", "2026-05-01T09:00:00.000Z", null);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, medical, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("holiday-a1", "admin-a", "a1", "2026-06-01", "2026-06-02", "A1", 0, "pending", "2026-05-01T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, medical, status, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("proposal-a1", "admin-a", "a1", "2026-06-10", "2026-06-11", "proposal A1", 0, "pending", "admin_proposal", "2026-05-01T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, medical, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("holiday-a2", "admin-a", "a2", "2026-07-01", "2026-07-02", "A2", 0, "pending", "2026-05-02T00:00:00.000Z");
  rawDb.prepare("INSERT INTO documents (id, restaurant_id, holiday_request_id) VALUES (?, ?, ?)")
    .run("doc-a1", "a1", "holiday-a1");
  rawDb.prepare("INSERT INTO documents (id, restaurant_id, holiday_request_id) VALUES (?, ?, ?)")
    .run("doc-a2", "a2", "holiday-a2");
});

describe("holiday routes active restaurant context", () => {
  test("GET /holidays lists active restaurant holidays with active document counts", async () => {
    const res = await app.request("/holidays", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => ({ id: row.id, reason: row.reason, documentCount: row.documentCount })))
      .toEqual([{ id: "holiday-a2", reason: "A2", documentCount: 1 }]);
  });

  test("GET /:id/documents cannot read legacy restaurant documents", async () => {
    const legacy = await app.request("/holidays/holiday-a1/documents", {
      headers: { cookie: "session=session-a" },
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/holidays/holiday-a2/documents", {
      headers: { cookie: "session=session-a" },
    });
    expect(active.status).toBe(200);
    const body = await active.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["doc-a2"]);
  });

  test("POST /holidays creates in active restaurant and bumps only its cache", async () => {
    const res = await app.request("/holidays", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ startDate: "2026-08-01", endDate: "2026-08-02", reason: "new" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.restaurantId).toBe("a2");

    const restaurants = rawDb.query("SELECT id, cache_version FROM restaurants ORDER BY id").all();
    expect(restaurants).toEqual([
      { id: "a1", cache_version: 0 },
      { id: "a2", cache_version: 1 },
    ]);
  });

  test("POST /holidays can create for an active-restaurant member despite legacy restaurant_id", async () => {
    const res = await app.request("/holidays", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ workerId: workerA2Uuid, startDate: "2026-08-10", endDate: "2026-08-11", reason: "member" }),
    });

    expect(res.status).toBe(201);
    const row = rawDb.query("SELECT worker_id, restaurant_id FROM holiday_requests WHERE reason = 'member'").get() as any;
    expect(row).toEqual({ worker_id: workerA2Uuid, restaurant_id: "a2" });
  });

  test("POST /holidays rejects accepted shared workers as target leave subjects", async () => {
    const res = await app.request("/holidays", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ workerId: sharedA1WorkerUuid, startDate: "2026-08-12", endDate: "2026-08-13", reason: "shared leave" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
  });

  test("POST /holidays/propose rejects accepted shared workers as target leave subjects", async () => {
    const res = await app.request("/holidays/propose", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ workerId: sharedA1WorkerUuid, startDate: "2026-08-12", endDate: "2026-08-13", reason: "proposal" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "worker_not_found" });
  });

  test("impact and review cannot touch legacy restaurant holidays", async () => {
    const impact = await app.request("/holidays/holiday-a1/impact", {
      headers: { cookie: "session=session-a" },
    });
    expect(impact.status).toBe(404);

    const review = await app.request("/holidays/holiday-a1/review", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(review.status).toBe(404);
  });

  test("respond cannot touch a legacy restaurant proposal for the same user", async () => {
    const res = await app.request("/holidays/proposal-a1/respond", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found_or_not_pending" });
  });
});
