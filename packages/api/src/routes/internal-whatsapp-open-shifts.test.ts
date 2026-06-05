import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-open-shifts-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
delete process.env.DEMO_CHAT_SECRET;

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");
const { processOpenShiftSolicitations } = await import("../services/notifications.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS open_shifts;
  DROP TABLE IF EXISTS published_weeks;
  DROP TABLE IF EXISTS services;
  DROP TABLE IF EXISTS holiday_requests;
  DROP TABLE IF EXISTS worker_availability;
  DROP TABLE IF EXISTS worker_restrictions;
  DROP TABLE IF EXISTS worker_preferred_schedule;
  DROP TABLE IF EXISTS worker_share_authorizations;
  DROP TABLE IF EXISTS worker_restaurant_profiles;
  DROP TABLE IF EXISTS restaurant_memberships;
  DROP TABLE IF EXISTS owner_memberships;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  DROP TABLE IF EXISTS owners;
  PRAGMA foreign_keys = ON;
  CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE restaurants (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', status TEXT NOT NULL DEFAULT 'active', subscription_status TEXT NOT NULL DEFAULT 'active', overtime_weekly_cap INTEGER NOT NULL DEFAULT 48, cache_version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    address TEXT,
    address_street TEXT,
    address_postal_code TEXT,
    address_city TEXT,
    iban TEXT,
    start_date TEXT,
    emergency_contact TEXT,
    emergency_phone TEXT,
    date_of_birth TEXT,
    birth_place TEXT,
    nationality TEXT,
    nir TEXT,
    notes TEXT,
    manager_notes TEXT,
    sub_role TEXT,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    overtime_willing INTEGER NOT NULL DEFAULT 0,
    coupure_willing INTEGER NOT NULL DEFAULT 0,
    multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
    matricule TEXT,
    contract_type TEXT,
    contract_hours INTEGER DEFAULT 35,
    max_weekly_hours INTEGER,
    admin_ot_override INTEGER,
    contract_end_date TEXT,
    hcr_level TEXT,
    hourly_rate INTEGER,
    rate_effective_from TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    inactive_from TEXT,
    inactive_until TEXT,
    permissions TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    user_notice_version TEXT,
    user_notice_accepted_at TEXT,
    user_notice_ip_address TEXT,
    user_notice_user_agent TEXT,
    whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
    whatsapp_opt_in_at TEXT,
    whatsapp_opt_out_at TEXT,
    last_dossier_reminder_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE owner_memberships (owner_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (owner_id, user_id));
  CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, permissions TEXT, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (restaurant_id, user_id));
  CREATE TABLE worker_restaurant_profiles (
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    contract_type TEXT,
    contract_hours INTEGER,
    contract_end_date TEXT,
    max_weekly_hours INTEGER,
    admin_ot_override INTEGER,
    hcr_level TEXT,
    hourly_rate INTEGER,
    matricule TEXT,
    manager_notes TEXT,
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
    status TEXT NOT NULL DEFAULT 'pending',
    invited_by_user_id TEXT NOT NULL,
    worker_consented_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE services (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', source TEXT NOT NULL DEFAULT 'manual', filled_as TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE open_shifts (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, created_by TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, role TEXT NOT NULL, required_sub_roles TEXT NOT NULL DEFAULT '[]', message TEXT, candidate_ids TEXT NOT NULL DEFAULT '[]', rejected_candidate_ids TEXT NOT NULL DEFAULT '[]', solicited_candidate_ids TEXT NOT NULL DEFAULT '[]', last_solicited_at TEXT, status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, claimed_at TEXT, service_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE holiday_requests (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, start_date TEXT, end_date TEXT, status TEXT);
  CREATE TABLE worker_availability (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, midi INTEGER, soir INTEGER, zones TEXT DEFAULT '{}');
  CREATE TABLE worker_restrictions (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, start_time TEXT, end_time TEXT, reason TEXT, effective_from TEXT, effective_until TEXT);
  CREATE TABLE worker_preferred_schedule (id TEXT PRIMARY KEY, worker_id TEXT, restaurant_id TEXT, day_of_week INTEGER, midi INTEGER, soir INTEGER, zones TEXT DEFAULT '{}');
  CREATE TABLE published_weeks (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, week_date TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, changes TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, type TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', scheduled_for TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const app = new Hono();
app.route("/internal/whatsapp", internalWhatsappRoutes);
const headers = (userId: string) => ({ "Content-Type": "application/json", "X-WhatsApp-Internal-Secret": "test-secret", "X-Comptoir-User-Id": userId });

beforeEach(() => {
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO owners (id, name) VALUES (?, ?)`).run("owner-1", "Owner One");
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, overtime_weekly_cap, cache_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("resto-1", "owner-1", "Resto", "Europe/Paris", "active", "active", 48, 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, priority, sub_roles, contract_hours) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`).run("worker-1", "Worker One", "worker@example.com", "+3361", "floor", "resto-1", 1, JSON.stringify([]), 35);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, priority, sub_roles, contract_hours) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`).run("other-worker", "Other Worker", "other@example.com", "+3362", "floor", "resto-1", 2, JSON.stringify([]), 35);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, priority, sub_roles, contract_hours) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`).run("admin-1", "Admin One", "admin@example.com", "+3363", "admin", "resto-1", 1, JSON.stringify([]), 35);
  for (const [userId, role] of [["worker-1", "floor"], ["other-worker", "floor"], ["admin-1", "admin"]] as const) {
    rawDb.prepare(`INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)`).run("owner-1", userId, role === "admin" ? "owner_admin" : "member");
    rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)`).run("resto-1", userId, role, 1);
  }
});

function seedAcceptedSharedWorker(options: { withSourceHours?: boolean } = {}) {
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, overtime_weekly_cap, cache_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("source-resto", "owner-1", "Source", "Europe/Paris", "active", "active", 48, 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`)
    .run("shared-worker", "Shared Worker", "shared@example.com", "+3364", "floor", "source-resto", 1, JSON.stringify([]), 35, 48, 1);
  rawDb.prepare(`INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)`)
    .run("owner-1", "shared-worker", "member");
  rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)`)
    .run("source-resto", "shared-worker", "floor", 1);
  rawDb.prepare(`INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("resto-1", "shared-worker", 1, JSON.stringify([]), 35, 48, 1);
  for (const dayOfWeek of [1, 2, 3, 4, 5, 6, 7]) {
    rawDb.prepare(`INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`shared-worker-target-${dayOfWeek}`, "shared-worker", "resto-1", dayOfWeek, 1, 1, "{}");
  }
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-target", "owner-1", "source-resto", "resto-1", "shared-worker", "floor", "accepted", "admin-1", "2099-01-01T00:00:00.000Z");

  if (!options.withSourceHours) return;

  for (const [id, date] of [["source-hours-1", "2099-05-04"], ["source-hours-2", "2099-05-05"], ["source-hours-3", "2099-05-06"]] as const) {
    rawDb.prepare(`INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, "source-resto", "shared-worker", date, "08:00", "23:00", "floor", "scheduled", "manual");
  }
}

describe("internal WhatsApp open-shift claim endpoint", () => {
  test("worker claims the first eligible open shift", async () => {
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("shift-1", "resto-1", "admin-1", "2099-05-04", "10:00", "14:00", "floor", JSON.stringify(["worker-1"]), "2099-05-04T10:00:00");
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("shift-sibling", "resto-1", "admin-1", "2099-05-04", "10:00", "14:00", "floor", JSON.stringify(["other-worker"]), "2099-05-04T10:00:00");

    const res = await app.request("/internal/whatsapp/me/open-shifts/claim", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.date).toBe("2099-05-04");
    const shift = rawDb.query(`SELECT status, claimed_by FROM open_shifts WHERE id='shift-1'`).get() as any;
    expect(shift).toEqual({ status: "claimed", claimed_by: "worker-1" });
    const sibling = rawDb.query(`SELECT status FROM open_shifts WHERE id='shift-sibling'`).get() as any;
    expect(sibling).toEqual({ status: "cancelled" });
    const service = rawDb.query(`SELECT worker_id, date, start_time, end_time FROM services`).get() as any;
    expect(service).toEqual({ worker_id: "worker-1", date: "2099-05-04", start_time: "10:00", end_time: "14:00" });
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE table_name='open_shifts'`).get() as any;
    expect(audit.source).toBe("bot:worker");
    const notification = rawDb.query(`SELECT type, recipient_id FROM notifications`).get() as any;
    expect(notification).toEqual({ type: "open_shift_claimed", recipient_id: "admin-1" });
  });

  test("no claimable open shift returns worker-facing 404", async () => {
    const res = await app.request("/internal/whatsapp/me/open-shifts/claim", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Aucun service ouvert ne t'attend pour l'instant." });
  });

  test("shared worker target claim hides stale source-restaurant weekly-cap candidates", async () => {
    seedAcceptedSharedWorker({ withSourceHours: true });
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("shared-target-shift", "resto-1", "admin-1", "2099-05-07", "10:00", "14:00", "floor", JSON.stringify(["shared-worker"]), "2099-05-07T10:00:00");

    const res = await app.request("/internal/whatsapp/me/open-shifts/claim", {
      method: "POST",
      headers: { ...headers("shared-worker"), "X-Comptoir-Restaurant-Id": "resto-1" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Aucun service ouvert ne t'attend pour l'instant." });
    const shift = rawDb.query(`SELECT status, claimed_by FROM open_shifts WHERE id='shared-target-shift'`).get() as any;
    expect(shift).toEqual({ status: "open", claimed_by: null });
    const services = rawDb.query(`SELECT id FROM services WHERE restaurant_id='resto-1'`).all();
    expect(services).toEqual([]);
  });

  test("shared worker claims target restaurant open shift through WhatsApp restaurant context", async () => {
    seedAcceptedSharedWorker();
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("shared-target-shift", "resto-1", "admin-1", "2099-05-04", "10:00", "14:00", "floor", JSON.stringify(["shared-worker"]), "2099-05-04T10:00:00");

    const res = await app.request("/internal/whatsapp/me/open-shifts/claim", {
      method: "POST",
      headers: { ...headers("shared-worker"), "X-Comptoir-Restaurant-Id": "resto-1" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        date: "2099-05-04",
        startTime: "10:00",
        endTime: "14:00",
        serviceId: expect.any(String),
      },
    });
    const shift = rawDb.query(`SELECT status, claimed_by FROM open_shifts WHERE id='shared-target-shift'`).get() as any;
    expect(shift).toEqual({ status: "claimed", claimed_by: "shared-worker" });
    const service = rawDb.query(`
      SELECT worker_id, restaurant_id, date, start_time, end_time, role, source
      FROM services
      WHERE worker_id = 'shared-worker'
    `).get() as any;
    expect(service).toEqual({
      worker_id: "shared-worker",
      restaurant_id: "resto-1",
      date: "2099-05-04",
      start_time: "10:00",
      end_time: "14:00",
      role: "floor",
      source: "manual",
    });
    const audit = rawDb.query(`SELECT restaurant_id, actor_id, source FROM audit_logs WHERE table_name='open_shifts'`).get() as any;
    expect(audit).toEqual({ restaurant_id: "resto-1", actor_id: "shared-worker", source: "bot:worker" });
  });

  test("shared worker declines target restaurant open shift through WhatsApp restaurant context", async () => {
    seedAcceptedSharedWorker();
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("shared-target-shift", "resto-1", "admin-1", "2099-05-04", "10:00", "14:00", "floor", JSON.stringify(["shared-worker"]), "2099-05-04T10:00:00");

    const res = await app.request("/internal/whatsapp/me/open-shifts/decline", {
      method: "POST",
      headers: { ...headers("shared-worker"), "X-Comptoir-Restaurant-Id": "resto-1" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { date: "2099-05-04", startTime: "10:00", endTime: "14:00" } });
    const shift = rawDb.query(`SELECT status, rejected_candidate_ids FROM open_shifts WHERE id='shared-target-shift'`).get() as any;
    expect(shift.status).toBe("open");
    expect(JSON.parse(shift.rejected_candidate_ids)).toEqual(["shared-worker"]);
    const notification = rawDb.query(`SELECT type, recipient_id, message FROM notifications`).get() as any;
    expect(notification.type).toBe("open_shift_claimed");
    expect(notification.recipient_id).toBe("admin-1");
    expect(notification.message).toContain("Shared Worker");
    expect(notification.message).toContain("refusé");
  });

  test("admin cannot claim an open shift", async () => {
    const res = await app.request("/internal/whatsapp/me/open-shifts/claim", { method: "POST", headers: headers("admin-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "En tant que gérant, tu publies des services ouverts depuis le tableau de bord. Tu ne les prends pas toi-même." });
  });

  test("worker declines an open shift and admin is notified", async () => {
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("shift-1", "resto-1", "admin-1", "2099-05-04", "10:00", "14:00", "floor", JSON.stringify(["worker-1"]), "2099-05-04T10:00:00");

    const res = await app.request("/internal/whatsapp/me/open-shifts/decline", { method: "POST", headers: headers("worker-1"), body: JSON.stringify({}) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { date: "2099-05-04", startTime: "10:00", endTime: "14:00" } });
    const shift = rawDb.query(`SELECT status, rejected_candidate_ids FROM open_shifts WHERE id='shift-1'`).get() as any;
    expect(shift.status).toBe("open");
    expect(JSON.parse(shift.rejected_candidate_ids)).toEqual(["worker-1"]);
    const notification = rawDb.query(`SELECT type, recipient_id, message FROM notifications`).get() as any;
    expect(notification.type).toBe("open_shift_claimed");
    expect(notification.recipient_id).toBe("admin-1");
    expect(notification.message).toContain("Worker One");
    expect(notification.message).toContain("refusé");
  });

  test("targeted open shift with no worker response notifies admin after ten minutes", async () => {
    rawDb.prepare(`INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, solicited_candidate_ids, last_solicited_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "shift-1",
      "resto-1",
      "admin-1",
      "2099-05-04",
      "10:00",
      "14:00",
      "floor",
      JSON.stringify(["worker-1"]),
      JSON.stringify(["worker-1"]),
      "2026-05-17T12:00:00.000Z",
      "2099-05-04T10:00:00",
    );

    const result = await processOpenShiftSolicitations(new Date("2026-05-17T12:11:00.000Z"));

    expect(result).toEqual({ sent: 0, waiting: 0, done: 1 });
    const shift = rawDb.query(`SELECT status FROM open_shifts WHERE id='shift-1'`).get() as any;
    expect(shift.status).toBe("expired");
    const notification = rawDb.query(`SELECT type, recipient_id, message FROM notifications`).get() as any;
    expect(notification.type).toBe("open_shift_no_response");
    expect(notification.recipient_id).toBe("admin-1");
    expect(notification.message).toContain("Worker One");
    expect(notification.message).toContain("Pas de réponse");
  });
});
