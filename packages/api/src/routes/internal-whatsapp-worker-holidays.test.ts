import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-worker-holidays-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS holiday_requests;
  DROP TABLE IF EXISTS worker_share_authorizations;
  DROP TABLE IF EXISTS worker_restaurant_profiles;
  DROP TABLE IF EXISTS restaurant_memberships;
  DROP TABLE IF EXISTS owner_memberships;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  DROP TABLE IF EXISTS owners;
  PRAGMA foreign_keys = ON;
  CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE restaurants (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', status TEXT NOT NULL DEFAULT 'active', subscription_status TEXT NOT NULL DEFAULT 'active', medical_mode INTEGER NOT NULL DEFAULT 0, cache_version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, role TEXT NOT NULL, restaurant_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, permissions TEXT, must_change_password INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE owner_memberships (owner_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (owner_id, user_id));
  CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, permissions TEXT, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (restaurant_id, user_id));
  CREATE TABLE worker_restaurant_profiles (restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1, sub_roles TEXT NOT NULL DEFAULT '[]', contract_hours INTEGER, max_weekly_hours INTEGER, PRIMARY KEY (restaurant_id, user_id));
  CREATE TABLE worker_share_authorizations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_restaurant_id TEXT NOT NULL, target_restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, invited_by_user_id TEXT NOT NULL, worker_consented_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE holiday_requests (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT, medical INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT 'worker', reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, changes TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, type TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', scheduled_for TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const app = new Hono();
app.route("/internal/whatsapp", internalWhatsappRoutes);
const headers = (userId: string) => ({ "Content-Type": "application/json", "X-WhatsApp-Internal-Secret": "test-secret", "X-Comptoir-User-Id": userId });

beforeEach(() => {
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO owners (id, name) VALUES (?, ?)`).run("owner-1", "Owner");
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, medical_mode, cache_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("resto-1", "owner-1", "Resto", "Europe/Paris", "active", "active", 0, 1);
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, medical_mode, cache_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("resto-2", "owner-1", "Other", "Europe/Paris", "active", "active", 0, 1);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`).run("worker-1", "Worker One", "worker@example.com", "+3361", "floor", "resto-1");
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`).run("admin-1", "Admin One", "admin@example.com", "+3362", "admin", "resto-1");
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`).run("foreign-worker", "Foreign Worker", "foreign@example.com", "+3363", "floor", "resto-2");
  for (const userId of ["worker-1", "admin-1", "foreign-worker"]) {
    rawDb.prepare(`INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)`)
      .run("owner-1", userId, userId === "admin-1" ? "owner_admin" : "member");
  }
  rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)`).run("resto-1", "worker-1", "floor", null, 1);
  rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)`).run("resto-1", "admin-1", "admin", null, 1);
  rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)`).run("resto-2", "foreign-worker", "floor", null, 1);
});

function seedAcceptedShareToTarget() {
  rawDb.prepare(`INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("resto-1", "foreign-worker", 1, "[]", 20, 24);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-foreign-target", "owner-1", "resto-2", "resto-1", "foreign-worker", "floor", "accepted", "admin-1", "2099-01-01T00:00:00.000Z");
}

describe("internal WhatsApp worker holiday endpoints", () => {
  test("worker can create a holiday request with bot audit source", async () => {
    const res = await app.request("/internal/whatsapp/me/holidays", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({ startDate: "2099-05-04", endDate: "2099-05-06", reason: "vacances" }) });

    expect(res.status).toBe(201);
    const row = rawDb.query(`SELECT worker_id, restaurant_id, status, reason FROM holiday_requests`).get() as any;
    expect(row).toEqual({ worker_id: "worker-1", restaurant_id: "resto-1", status: "pending", reason: "vacances" });
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE table_name='holiday_requests'`).get() as any;
    expect(audit.source).toBe("bot:worker");
    const notification = rawDb.query(`SELECT type, recipient_id FROM notifications`).get() as any;
    expect(notification).toEqual({ type: "holiday_request", recipient_id: "admin-1" });
  });

  test("medical mode auto-approves sick leave", async () => {
    rawDb.prepare(`UPDATE restaurants SET medical_mode=1 WHERE id='resto-1'`).run();

    const res = await app.request("/internal/whatsapp/me/holidays", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({ startDate: "2099-05-04", endDate: "2099-05-04", reason: "arrêt maladie" }) });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.isMedical).toBe(true);
    const row = rawDb.query(`SELECT medical, status FROM holiday_requests`).get() as any;
    expect(row).toEqual({ medical: 1, status: "approved" });
  });

  test("overlapping pending holiday is rejected", async () => {
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)`).run("hol-1", "worker-1", "resto-1", "2099-05-04", "2099-05-06", "pending");

    const res = await app.request("/internal/whatsapp/me/holidays", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({ startDate: "2099-05-05", endDate: "2099-05-05" }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Tu as déjà une demande de congé en cours pour ces dates. Vérifie tes congés avec *mes congés*." });
  });

  test("own list is scoped to worker and restaurant", async () => {
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("hol-1", "worker-1", "resto-1", "2099-05-04", "2099-05-06", "vacances", "pending");
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("hol-foreign", "foreign-worker", "resto-2", "2099-05-04", "2099-05-06", "secret", "pending");

    const res = await app.request("/internal/whatsapp/me/holidays", { headers: headers("worker-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.holidays.map((h: { id: string }) => h.id)).toEqual(["hol-1"]);
  });

  test("accepted shared workers cannot create target-restaurant holiday requests", async () => {
    seedAcceptedShareToTarget();

    const res = await app.request("/internal/whatsapp/me/holidays", {
      method: "POST",
      headers: { ...headers("foreign-worker"), "X-Comptoir-Restaurant-Id": "resto-1" },
      body: JSON.stringify({ startDate: "2099-05-04", endDate: "2099-05-06", reason: "vacances" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Les congés restent liés à ton restaurant employeur. Change de contexte vers ton restaurant principal pour gérer tes congés.",
    });
    expect(rawDb.query(`SELECT COUNT(*) AS count FROM holiday_requests`).get()).toEqual({ count: 0 });
  });

  test("accepted shared workers cannot read target-restaurant holiday requests", async () => {
    seedAcceptedShareToTarget();
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("hol-shared-target", "foreign-worker", "resto-1", "2099-05-04", "2099-05-06", "target secret", "pending");

    const res = await app.request("/internal/whatsapp/me/holidays", {
      headers: { ...headers("foreign-worker"), "X-Comptoir-Restaurant-Id": "resto-1" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Les congés restent liés à ton restaurant employeur. Change de contexte vers ton restaurant principal pour gérer tes congés.",
    });
  });
});
