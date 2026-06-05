import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";
import { forbiddenShareResponseFields } from "../test/shared-worker-privacy-fields.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-routes-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS replacement_requests;
  DROP TABLE IF EXISTS holiday_requests;
  DROP TABLE IF EXISTS audit_logs;
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS time_clocks;
  DROP TABLE IF EXISTS whatsapp_context_sessions;
  DROP TABLE IF EXISTS chat_messages;
  DROP TABLE IF EXISTS open_shifts;
  DROP TABLE IF EXISTS worker_availability;
  DROP TABLE IF EXISTS worker_share_authorizations;
  DROP TABLE IF EXISTS worker_restaurant_profiles;
  DROP TABLE IF EXISTS weather_data;
  DROP TABLE IF EXISTS calendar_events;
  DROP TABLE IF EXISTS daily_revenue;
  DROP TABLE IF EXISTS restaurant_closures;
  DROP TABLE IF EXISTS published_weeks;
  DROP TABLE IF EXISTS staffing_targets;
  DROP TABLE IF EXISTS staffing_schedule;
  DROP TABLE IF EXISTS staffing_profiles;
  DROP TABLE IF EXISTS service_templates;
  DROP TABLE IF EXISTS services;
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
    timezone TEXT NOT NULL,
    status TEXT NOT NULL,
    subscription_status TEXT NOT NULL,
    cache_version INTEGER NOT NULL DEFAULT 0,
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
    priority INTEGER NOT NULL DEFAULT 1,
    sub_roles TEXT NOT NULL DEFAULT '[]',
    contract_hours INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    permissions TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE service_templates (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    profile_id TEXT,
    role TEXT NOT NULL DEFAULT 'floor',
    zone TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL DEFAULT '14:00',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE staffing_profiles (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    day_priorities TEXT NOT NULL DEFAULT '{}',
    preferred_assignments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE staffing_schedule (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    week INTEGER NOT NULL
  );
  CREATE TABLE staffing_targets (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    profile_id TEXT,
    day_of_week INTEGER NOT NULL,
    role TEXT NOT NULL,
    zone TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    role_breakdown TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE published_weeks (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    week_date TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE restaurant_closures (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    reason TEXT,
    schedule TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE daily_revenue (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    end_date TEXT,
    name TEXT NOT NULL,
    zone TEXT,
    year INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE weather_data (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    date TEXT NOT NULL,
    weather_code INTEGER,
    temp_max INTEGER,
    temp_min INTEGER,
    sunrise TEXT,
    sunset TEXT,
    normal_temp_max INTEGER,
    normal_temp_min INTEGER,
    hourly_weather_codes TEXT,
    hourly_temperatures TEXT,
    is_forecast INTEGER NOT NULL DEFAULT 1,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, changes TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
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
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE whatsapp_context_sessions (
    phone TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    selected_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
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
  CREATE TABLE worker_availability (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    midi INTEGER NOT NULL DEFAULT 1,
    soir INTEGER NOT NULL DEFAULT 1,
    zones TEXT NOT NULL DEFAULT '{}'
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
  CREATE TABLE replacement_requests (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    requester_service_id TEXT NOT NULL,
    target_id TEXT,
    restaurant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
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
`);

const app = new Hono();
app.route("/internal/whatsapp", internalWhatsappRoutes);

const FORBIDDEN_WHATSAPP_SHARED_ROSTER_FIELDS = forbiddenShareResponseFields
  .filter((field: string) => !["phone", "subRoles", "contractHours"].includes(field));

function expectWhatsappSharedRosterPrivacy(row: Record<string, unknown>) {
  for (const field of FORBIDDEN_WHATSAPP_SHARED_ROSTER_FIELDS) {
    expect(row).not.toHaveProperty(field);
  }
  expect(row.phone).toBeNull();
}

function authHeaders(userId: string) {
  return {
    "X-WhatsApp-Internal-Secret": "test-secret",
    "X-Comptoir-User-Id": userId,
  };
}

function todayInParis() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function insertUser(id: string, restaurantId: string, role: string, permissions: Record<string, boolean> | null = null) {
  rawDb.prepare(`
    INSERT INTO users (id, name, email, phone, role, restaurant_id, priority, sub_roles, contract_hours, active, permissions, must_change_password, whatsapp_opt_in)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 1)
  `).run(
    id,
    id === "worker-1" ? "Alice Martin" : id === "worker-2" ? "Bob Chef" : `User ${id}`,
    `${id}@example.com`,
    `+3360000${id.slice(-1).padStart(4, "0")}`,
    role,
    restaurantId,
    id === "worker-2" ? 1 : 2,
    id === "worker-2" ? JSON.stringify(["Chef"]) : JSON.stringify([]),
    35,
    permissions ? JSON.stringify(permissions) : null,
  );
  rawDb.prepare(`
    INSERT OR REPLACE INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active)
    VALUES (?, ?, ?, ?, 1)
  `).run(restaurantId, id, role, permissions ? JSON.stringify(permissions) : null);
  rawDb.prepare(`
    INSERT OR IGNORE INTO owner_memberships (owner_id, user_id, role)
    VALUES (?, ?, ?)
  `).run("owner-1", id, role === "admin" ? "owner_admin" : "member");
}

function seedAcceptedShare(userId = "foreign-worker") {
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run("resto-1", userId, 1, JSON.stringify(["Renfort"]), 24, 35);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
  `).run("share-foreign", "owner-1", "resto-2", "resto-1", userId, "floor", "admin-1", "2026-05-01T10:00:00.000Z");
}

function seedMidiFloorStaffingTarget(count = 2) {
  rawDb.prepare(`INSERT INTO staffing_profiles (id, restaurant_id, name, sort_order) VALUES (?, ?, ?, ?)`).run(
    "staffing-main", "resto-1", "Main profile", 1,
  );
  rawDb.prepare(`INSERT INTO staffing_targets (id, restaurant_id, profile_id, day_of_week, role, zone, count) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "staffing-midi-floor", "resto-1", "staffing-main", 1, "floor", "Midi", count,
  );
}

const staleAcceptedShareScenarios = [
  {
    name: "revoked",
    mutate: () => rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-foreign"),
  },
  {
    name: "missing worker consent",
    mutate: () => rawDb.prepare("UPDATE worker_share_authorizations SET worker_consented_at = NULL WHERE id = ?")
      .run("share-foreign"),
  },
  {
    name: "source membership inactive",
    mutate: () => rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("resto-2", "foreign-worker"),
  },
  {
    name: "source role drifted",
    mutate: () => rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("manager", "resto-2", "foreign-worker"),
  },
  {
    name: "worker left owner account",
    mutate: () => rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-1", "foreign-worker"),
  },
  {
    name: "worker account inactive",
    mutate: () => rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?")
      .run("foreign-worker"),
  },
  {
    name: "source owner drifted",
    mutate: () => rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-2", "resto-2"),
  },
  {
    name: "target owner drifted",
    mutate: () => rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-2", "resto-1"),
  },
  {
    name: "target profile missing",
    mutate: () => rawDb.prepare("DELETE FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
      .run("resto-1", "foreign-worker"),
  },
];

beforeEach(() => {
  process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO owners (id, name) VALUES (?, ?)`).run("owner-1", "Owner 1");
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?, ?)`).run("resto-1", "owner-1", "Resto 1", "Europe/Paris", "active", "active");
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?, ?)`).run("resto-2", "owner-1", "Resto 2", "Europe/Paris", "active", "active");

  insertUser("admin-1", "resto-1", "admin");
  insertUser("manager-ok", "resto-1", "manager", { TEAM_VIEW: true, HOURS_VIEW: true });
  insertUser("manager-no-team", "resto-1", "manager", { TEAM_VIEW: false, HOURS_VIEW: true });
  insertUser("manager-no-hours", "resto-1", "manager", { TEAM_VIEW: true, HOURS_VIEW: false });
  insertUser("manager-no-leave", "resto-1", "manager", { LEAVE_APPROVE: false });
  insertUser("worker-1", "resto-1", "floor");
  insertUser("worker-2", "resto-1", "kitchen");
  insertUser("foreign-worker", "resto-2", "floor");
  rawDb.prepare(`UPDATE users SET phone = ? WHERE id = ?`).run("+33699990001", "admin-1");

  rawDb.prepare(`INSERT INTO service_templates (id, restaurant_id, role, zone, start_time, end_time, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("tmpl-midi", "resto-1", "floor", "Midi", "10:00", "14:00", 1);
  rawDb.prepare(`INSERT INTO service_templates (id, restaurant_id, role, zone, start_time, end_time, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("tmpl-soir", "resto-1", "floor", "Soir", "18:00", "23:00", 2);
  rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "svc-1", "worker-1", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled",
  );
  rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "svc-2", "worker-1", "resto-1", "2026-05-05", "18:00", "23:00", "floor", "scheduled",
  );
  rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "foreign-svc", "foreign-worker", "resto-2", "2026-05-04", "10:00", "14:00", "floor", "scheduled",
  );
});

describe("internal WhatsApp read-only team endpoints", () => {
  test("identity resolution uses secret-only auth", async () => {
    const missing = await app.request("/internal/whatsapp/identity/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+33699990001" }) });
    expect(missing.status).toBe(403);

    const res = await app.request("/internal/whatsapp/identity/resolve", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+33699990001" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, identity: { userId: "admin-1", restaurantId: "resto-1", restaurantName: "Resto 1" } });
  });

  test("identity resolution blocks workers who have not opted into WhatsApp", async () => {
    rawDb.prepare("UPDATE users SET whatsapp_opt_in = 0 WHERE id = ?").run("worker-1");

    const res = await app.request("/internal/whatsapp/identity/resolve", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+33600000001" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, blocked: true });
  });

  test("identity resolution asks for restaurant context when a phone is ambiguous", async () => {
    insertUser("admin-2", "resto-2", "admin");
    rawDb.prepare("UPDATE users SET phone = ? WHERE id = ?").run("+33699990001", "admin-2");

    const ambiguous = await app.request("/internal/whatsapp/identity/resolve", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33699990001" }),
    });

    expect(ambiguous.status).toBe(200);
    expect(await ambiguous.json()).toEqual({
      ok: false,
      blocked: false,
      code: "RESTAURANT_CONTEXT_REQUIRED",
      message: "Votre numéro est associé à plusieurs restaurants. Choisissez le restaurant avant de continuer.",
      restaurants: [
        { id: "resto-1", name: "Resto 1", status: "active" },
        { id: "resto-2", name: "Resto 2", status: "active" },
      ],
    });

    const selected = await app.request("/internal/whatsapp/identity/resolve", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33699990001", restaurantId: "resto-2" }),
    });

    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ ok: true, identity: { userId: "admin-2", restaurantId: "resto-2", restaurantName: "Resto 2" } });
  });

  test("identity resolution reuses selected restaurant context until it expires", async () => {
    insertUser("admin-2", "resto-2", "admin");
    rawDb.prepare("UPDATE users SET phone = ? WHERE id IN (?, ?)").run("+33699990001", "admin-1", "admin-2");

    const selected = await app.request("/internal/whatsapp/identity/resolve", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33699990001", restaurantId: "resto-2" }),
    });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ ok: true, identity: { userId: "admin-2", restaurantId: "resto-2" } });

    const reused = await app.request("/internal/whatsapp/identity/resolve", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33699990001" }),
    });
    expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({ ok: true, identity: { userId: "admin-2", restaurantId: "resto-2" } });

    rawDb.prepare("UPDATE whatsapp_context_sessions SET expires_at = ? WHERE phone = ?").run("2000-01-01T00:00:00.000Z", "+33699990001");

    const expired = await app.request("/internal/whatsapp/identity/resolve", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33699990001" }),
    });
    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({ ok: false, code: "RESTAURANT_CONTEXT_REQUIRED" });
  });

  test("identity resolution uses active restaurant membership even when legacy users.restaurant_id differs", async () => {
    rawDb.prepare(`
      INSERT OR REPLACE INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active)
      VALUES (?, ?, ?, ?, 1)
    `).run("resto-2", "worker-1", "floor", null);

    const res = await app.request("/internal/whatsapp/identity/resolve", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33600000001", restaurantId: "resto-2" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      identity: { userId: "worker-1", restaurantId: "resto-2", restaurantName: "Resto 2" },
    });
  });

  test("tool auth rejects an unowned selected restaurant context", async () => {
    const res = await app.request("/internal/whatsapp/context", {
      headers: {
        ...authHeaders("worker-1"),
        "X-Comptoir-Restaurant-Id": "resto-2",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Restaurant inaccessible", code: "RESTAURANT_CONTEXT_FORBIDDEN" });
  });

  test("notification recording uses secret-only auth and returns recipient phone", async () => {
    const missing = await app.request("/internal/whatsapp/notifications/record", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", message: "Salut", type: "schedule_change" }) });
    expect(missing.status).toBe(403);

    const res = await app.request("/internal/whatsapp/notifications/record", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", message: "Salut", type: "schedule_change" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { phone: "+33600000001" } });
    const chat = rawDb.query(`SELECT role, content FROM chat_messages WHERE user_id='worker-1'`).get() as any;
    expect(chat).toEqual({ role: "assistant", content: "Salut" });
    const notification = rawDb.query(`SELECT recipient_id, type, message FROM notifications WHERE recipient_id='worker-1'`).get() as any;
    expect(notification).toEqual({ recipient_id: "worker-1", type: "schedule_change", message: "Salut" });
  });

  test("notification recording requires WhatsApp opt-in for non-admin users", async () => {
    rawDb.prepare("UPDATE users SET whatsapp_opt_in = 0 WHERE id = ?").run("worker-1");

    const res = await app.request("/internal/whatsapp/notifications/record", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", message: "Salut", type: "schedule_change" }) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "WhatsApp opt-in required" });
  });

  test("notification recording uses active restaurant membership for consent context", async () => {
    rawDb.prepare("UPDATE users SET restaurant_id = ?, whatsapp_opt_in = 0 WHERE id = ?").run("resto-2", "worker-1");
    rawDb.prepare("UPDATE restaurants SET status = ? WHERE id = ?").run("demo", "resto-1");

    const res = await app.request("/internal/whatsapp/notifications/record", {
      method: "POST",
      headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "worker-1", message: "Salut demo", type: "schedule_change" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { phone: "+33600000001" } });
  });

  test("notification listing and chat clear use secret-only auth", async () => {
    rawDb.prepare(`INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run("chat-1", "worker-1", "user", "bonjour", "2099-01-01 10:00:00");
    rawDb.prepare(`INSERT INTO notifications (id, recipient_id, type, message, status, scheduled_for, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("notif-1", "worker-1", "schedule_change", "Salut", "queued", "2099-01-01T10:00:00.000Z", "2099-01-01 10:00:00");

    const list = await app.request("/internal/whatsapp/notifications/list", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", since: "2099-01-01T09:00:00.000Z" }) });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: { notifications: [{ id: "notif-1", type: "schedule_change", message: "Salut", createdAt: "2099-01-01 10:00:00" }] } });

    const clear = await app.request("/internal/whatsapp/chat/clear", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1" }) });
    expect(clear.status).toBe(200);
    const chat = rawDb.query(`SELECT id FROM chat_messages WHERE user_id='worker-1'`).all();
    expect(chat).toEqual([]);
  });

  test("webhook storage endpoints expire messages and validate document uploads", async () => {
    rawDb.prepare(`INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run("expired-chat", "worker-1", "user", "ancien", "2000-01-01 10:00:00");
    rawDb.prepare(`INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run("fresh-chat", "worker-1", "user", "récent", "2099-01-01 10:00:00");
    const expire = await app.request("/internal/whatsapp/chat/expire-old", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret" } });
    expect(expire.status).toBe(200);
    expect(rawDb.query(`SELECT id FROM chat_messages ORDER BY id`).all()).toEqual([{ id: "fresh-chat" }]);

    const missing = await app.request("/internal/whatsapp/documents/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(missing.status).toBe(403);
    const foreign = await app.request("/internal/whatsapp/documents/upload", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", restaurantId: "resto-2", name: "Doc", filename: "doc.pdf", mimeType: "application/pdf", size: 10, base64: "ZmFrZQ==" }) });
    expect(foreign.status).toBe(404);
    const invalidUpload = await app.request("/internal/whatsapp/documents/upload", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", restaurantId: "resto-1", name: "Doc", filename: "doc.pdf", mimeType: "application/pdf", size: 10, base64: "ZmFrZQ==" }) });
    expect(invalidUpload.status).toBe(400);
  });

  test("conversation history endpoints own save, trim, reset, and stale cleanup", async () => {
    const missing = await app.request("/internal/whatsapp/chat/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1" }) });
    expect(missing.status).toBe(403);

    rawDb.prepare(`INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run("old-chat", "worker-1", "user", "ancien", "2000-01-01 10:00:00");
    const stale = await app.request("/internal/whatsapp/chat/history", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1" }) });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ data: { messages: [] } });
    expect(rawDb.query(`SELECT id FROM chat_messages WHERE user_id='worker-1'`).all()).toEqual([]);

    const save = await app.request("/internal/whatsapp/chat/messages", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1", role: "user", content: "sauvé" }) });
    expect(save.status).toBe(200);
    expect(rawDb.query(`SELECT role, content FROM chat_messages WHERE user_id='worker-1'`).get()).toEqual({ role: "user", content: "sauvé" });

    rawDb.exec("DELETE FROM chat_messages;");
    for (let i = 0; i < 8; i++) {
      rawDb.prepare(`INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(`hist-${i}`, "worker-1", i % 2 === 0 ? "user" : "assistant", `m${i}`, `2099-01-01 10:00:0${i}`);
    }
    const history = await app.request("/internal/whatsapp/chat/history", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1" }) });
    expect(await history.json()).toEqual({ data: { messages: [
      { role: "user", content: "m2" },
      { role: "assistant", content: "m3" },
      { role: "user", content: "m4" },
      { role: "assistant", content: "m5" },
      { role: "user", content: "m6" },
      { role: "assistant", content: "m7" },
    ] } });

    rawDb.exec("DELETE FROM chat_messages;");
    for (let i = 0; i < 14; i++) {
      rawDb.prepare(`INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(`trim-${i}`, "worker-1", "user", `m${i}`, `2099-01-01 10:00:${String(i).padStart(2, "0")}`);
    }
    const trim = await app.request("/internal/whatsapp/chat/trim", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1" }) });
    expect(trim.status).toBe(200);
    expect(rawDb.query(`SELECT id FROM chat_messages WHERE user_id='worker-1' ORDER BY created_at`).all()).toHaveLength(12);
    expect(rawDb.query(`SELECT id FROM chat_messages WHERE id='trim-0' OR id='trim-1'`).all()).toEqual([]);

    const reset = await app.request("/internal/whatsapp/chat/reset-after-confirmation", { method: "POST", headers: { "X-WhatsApp-Internal-Secret": "test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "worker-1" }) });
    expect(reset.status).toBe(200);
    expect(rawDb.query(`SELECT id FROM chat_messages WHERE user_id='worker-1'`).all()).toHaveLength(2);
  });

  test("TEAM_VIEW=false blocks team listing", async () => {
    const res = await app.request("/internal/whatsapp/team", { headers: authHeaders("manager-no-team") });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  test("valid manager can list active non-admin team members", async () => {
    const res = await app.request("/internal/whatsapp/team", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.members.map((w: { id: string }) => w.id)).toEqual(["worker-2", "worker-1", "manager-no-hours", "manager-no-leave", "manager-no-team", "manager-ok"]);
  });

  test("valid manager can see accepted shared workers as scheduling-only team members", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/team", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    const shared = json.data.members.find((w: { id: string }) => w.id === "foreign-worker");
    expect(shared).toMatchObject({
      id: "foreign-worker",
      name: "User foreign-worker",
      role: "floor",
      subRoles: JSON.stringify(["Renfort"]),
      contractHours: 24,
      phone: null,
      restaurantId: "resto-1",
      sharedFromRestaurantId: "resto-2",
    });
    expectWhatsappSharedRosterPrivacy(shared);
  });

  test("worker resolution returns accepted shared workers without HR or contact fields", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/workers/resolve?name=foreign", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.worker).toMatchObject({
      id: "foreign-worker",
      name: "User foreign-worker",
      role: "floor",
      sharedFromRestaurantId: "resto-2",
    });
    expectWhatsappSharedRosterPrivacy(json.data.worker);
  });

  test("leave-scoped worker resolution does not expose accepted shared workers as HR subjects", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/workers/resolve?name=foreign&scope=leave", { headers: authHeaders("admin-1") });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Worker not found");
    expect(json.team).not.toContain("User foreign-worker");
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`valid manager cannot see stale accepted shared workers in team listing when ${scenario.name}`, async () => {
      seedAcceptedShare();
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/team", { headers: authHeaders("manager-ok") });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.members.map((w: { id: string }) => w.id)).not.toContain("foreign-worker");
    });
  }

  test("prompt context returns zones and permission-scoped team", async () => {
    const allowed = await app.request("/internal/whatsapp/context", { headers: authHeaders("manager-ok") });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ data: { zones: ["Midi", "Soir"], team: { kitchen: ["Bob Chef"], floor: ["Alice Martin"] } } });

    const denied = await app.request("/internal/whatsapp/context", { headers: authHeaders("manager-no-team") });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ data: { zones: ["Midi", "Soir"], team: { kitchen: [], floor: [] } } });
  });

  test("prompt context includes accepted shared workers as scheduling names only", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/context", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        zones: ["Midi", "Soir"],
        team: {
          kitchen: ["Bob Chef"],
          floor: ["User foreign-worker", "Alice Martin"],
        },
      },
    });
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`prompt context hides stale accepted shared workers when ${scenario.name}`, async () => {
      seedAcceptedShare();
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/context", { headers: authHeaders("manager-ok") });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.team.floor).not.toContain("User foreign-worker");
    });
  }

  test("planning prompt resolves accepted shared workers and checks source restaurant overlap", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/planning/services/prepare", {
      method: "POST",
      headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ workerName: "foreign", date: "2026-05-04", zone: "Midi" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        status: "overlap",
        worker: { id: "foreign-worker", sharedFromRestaurantId: "resto-2" },
        overlap: { startTime: "10:00", endTime: "14:00" },
      },
    });
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`planning prompt cannot prepare stale accepted shared workers when ${scenario.name}`, async () => {
      seedAcceptedShare();
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/planning/services/prepare", {
        method: "POST",
        headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
        body: JSON.stringify({ workerName: "foreign", date: "2026-05-04", zone: "Midi" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Worker not found");
      expect(json.team).not.toContain("User foreign-worker");
    });
  }

  test("RESTAURANT_SETTINGS=false blocks closures", async () => {
    const res = await app.request("/internal/whatsapp/closures", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(403);
  });

  test("admin can list and create closures", async () => {
    rawDb.prepare(`INSERT INTO restaurant_closures (id, restaurant_id, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)`).run("closure-1", "resto-1", "2099-05-01", "2099-05-02", "travaux");

    const list = await app.request("/internal/whatsapp/closures", { headers: authHeaders("admin-1") });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.data.closures).toEqual([{ startDate: "2099-05-01", endDate: "2099-05-02", reason: "travaux" }]);

    const create = await app.request("/internal/whatsapp/closures", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ startDate: "2099-06-01", endDate: "2099-06-02", reason: "repos" }) });
    expect(create.status).toBe(201);
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE table_name='restaurant_closures'`).get() as any;
    expect(audit.source).toBe("bot:admin");
  });

  test("admin can prepare planning prompts through API", async () => {
    const add = await app.request("/internal/whatsapp/planning/services/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ workerName: "Alice", date: "2099-05-04", zone: "Midi" }) });
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ data: { status: "ok", worker: { id: "worker-1", name: "Alice Martin" }, date: "2099-05-04", startTime: "10:00", endTime: "14:00", zone: "Midi" } });

    const del = await app.request("/internal/whatsapp/planning/services/prepare-delete", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ workerName: "Alice", date: "2026-05-04" }) });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ data: { status: "ok", service: { id: "svc-1", zone: "Midi" } } });

    const publish = await app.request("/internal/whatsapp/planning/weeks/prepare-publish", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ weekStart: "2026-05-04", weekEnd: "2026-05-10" }) });
    expect(publish.status).toBe(200);
    expect(await publish.json()).toMatchObject({ data: { status: "ok", serviceCount: 2, workerCount: 1 } });
  });

  test("shared worker delete preparation stays target-scoped and does not expose source-only services", async () => {
    seedAcceptedShare();

    const sourceOnly = await app.request("/internal/whatsapp/planning/services/prepare-delete", {
      method: "POST",
      headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ workerName: "foreign", date: "2026-05-04" }),
    });
    expect(sourceOnly.status).toBe(200);
    expect(await sourceOnly.json()).toMatchObject({
      data: {
        status: "none",
        worker: { id: "foreign-worker", sharedFromRestaurantId: "resto-2" },
        date: "2026-05-04",
      },
    });

    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-svc", "foreign-worker", "resto-1", "2026-05-04", "18:00", "23:00", "floor", "scheduled",
    );

    const targetService = await app.request("/internal/whatsapp/planning/services/prepare-delete", {
      method: "POST",
      headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ workerName: "foreign", date: "2026-05-04" }),
    });

    expect(targetService.status).toBe(200);
    expect(await targetService.json()).toMatchObject({
      data: {
        status: "ok",
        worker: { id: "foreign-worker", sharedFromRestaurantId: "resto-2" },
        service: { id: "foreign-target-svc", zone: "Soir" },
      },
    });
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`shared worker delete preparation hides stale accepted shares when ${scenario.name}`, async () => {
      seedAcceptedShare();
      rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "foreign-target-svc", "foreign-worker", "resto-1", "2026-05-04", "18:00", "23:00", "floor", "scheduled",
      );
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/planning/services/prepare-delete", {
        method: "POST",
        headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
        body: JSON.stringify({ workerName: "foreign", date: "2026-05-04" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Worker not found");
      expect(json.team).not.toContain("User foreign-worker");
    });
  }

  test("targeted open-shift preparation rejects wrong-role workers without creating a row", async () => {
    const res = await app.request("/internal/whatsapp/planning/open-shift/request-worker", {
      method: "POST",
      headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ workerName: "Alice", date: "2099-05-04", role: "kitchen", startTime: "10:00", endTime: "14:00" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "not_candidate", worker: { id: "worker-1" }, role: "kitchen" } });
    expect(rawDb.query("SELECT COUNT(*) AS count FROM open_shifts").get()).toEqual({ count: 0 });
  });

  test("planning service preparation rejects wrong-role workers before confirmation", async () => {
    const res = await app.request("/internal/whatsapp/planning/services/prepare", {
      method: "POST",
      headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" },
      body: JSON.stringify({ workerName: "Alice", date: "2099-05-04", role: "kitchen", startTime: "10:00", endTime: "14:00" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "not_candidate", worker: { id: "worker-1" }, role: "kitchen" } });
  });

  test("TEAM_VIEW=false blocks weather and calendar", async () => {
    const weather = await app.request("/internal/whatsapp/weather?date=2026-05-04", { headers: authHeaders("manager-no-team") });
    const calendar = await app.request("/internal/whatsapp/calendar?month=2026-05", { headers: authHeaders("manager-no-team") });

    expect(weather.status).toBe(403);
    expect(calendar.status).toBe(403);
  });

  test("manager can read weather and calendar scoped to restaurant", async () => {
    rawDb.prepare(`INSERT INTO weather_data (id, restaurant_id, date, weather_code, temp_min, temp_max, sunrise, sunset, normal_temp_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("weather-1", "resto-1", "2026-05-04", 1, 12, 21, "2026-05-04T06:30:00", "2026-05-04T21:15:00", 17);
    rawDb.prepare(`INSERT INTO weather_data (id, restaurant_id, date, weather_code, temp_min, temp_max) VALUES (?, ?, ?, ?, ?, ?)`).run("weather-foreign", "resto-2", "2026-05-04", 95, 0, 1);
    rawDb.prepare(`INSERT INTO calendar_events (id, restaurant_id, type, date, end_date, name, year) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("cal-1", "resto-1", "public_holiday", "2026-05-01", null, "Fête du Travail", 2026);
    rawDb.prepare(`INSERT INTO calendar_events (id, restaurant_id, type, date, end_date, name, year) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("cal-2", "resto-1", "school_vacation", "2026-05-10", "2026-05-20", "Vacances", 2026);
    rawDb.prepare(`INSERT INTO calendar_events (id, restaurant_id, type, date, end_date, name, year) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("cal-foreign", "resto-2", "public_holiday", "2026-05-01", null, "Secret", 2026);

    const weather = await app.request("/internal/whatsapp/weather?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(weather.status).toBe(200);
    expect(await weather.json()).toEqual({ data: { date: "2026-05-04", weather: { weatherCode: 1, tempMin: 12, tempMax: 21, sunrise: "2026-05-04T06:30:00", sunset: "2026-05-04T21:15:00", normalTempMax: 17, normalTempMin: null } } });

    const calendar = await app.request("/internal/whatsapp/calendar?month=2026-05", { headers: authHeaders("manager-ok") });
    expect(calendar.status).toBe(200);
    expect(await calendar.json()).toEqual({ data: { month: "2026-05", label: "mai 2026", events: [
      { type: "public_holiday", date: "2026-05-01", endDate: null, name: "Fête du Travail" },
      { type: "school_vacation", date: "2026-05-10", endDate: "2026-05-20", name: "Vacances" },
    ] } });
  });

  test("HOURS_VIEW=false blocks revenue reads", async () => {
    const res = await app.request("/internal/whatsapp/revenue?date=2026-05-04", { headers: authHeaders("manager-no-hours") });

    expect(res.status).toBe(403);
  });

  test("admin can read day and month revenue", async () => {
    rawDb.prepare(`INSERT INTO daily_revenue (id, restaurant_id, date, amount) VALUES (?, ?, ?, ?)`).run("rev-1", "resto-1", "2026-05-04", 123400);
    rawDb.prepare(`INSERT INTO daily_revenue (id, restaurant_id, date, amount) VALUES (?, ?, ?, ?)`).run("rev-2", "resto-1", "2026-05-05", 200000);
    rawDb.prepare(`INSERT INTO daily_revenue (id, restaurant_id, date, amount) VALUES (?, ?, ?, ?)`).run("foreign-rev", "resto-2", "2026-05-04", 999999);

    const day = await app.request("/internal/whatsapp/revenue?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(day.status).toBe(200);
    expect(await day.json()).toEqual({ data: { kind: "day", date: "2026-05-04", amount: 123400 } });

    const month = await app.request("/internal/whatsapp/revenue?date=2026-05", { headers: authHeaders("manager-ok") });
    expect(month.status).toBe(200);
    expect(await month.json()).toMatchObject({ data: { kind: "month", month: "2026-05", label: "mai 2026", total: 323400, avg: 161700, best: { date: "2026-05-05", amount: 200000 } } });
  });

  test("RESTAURANT_SETTINGS=false blocks revenue writes", async () => {
    const res = await app.request("/internal/whatsapp/revenue", { method: "POST", headers: { ...authHeaders("manager-ok"), "Content-Type": "application/json" }, body: JSON.stringify({ date: "2026-05-04", amount: 123400 }) });

    expect(res.status).toBe(403);
  });

  test("admin can upsert revenue with bot audit source", async () => {
    const res = await app.request("/internal/whatsapp/revenue", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ date: "2026-05-04", amount: 123400 }) });
    expect(res.status).toBe(201);
    const row = rawDb.query(`SELECT restaurant_id, date, amount FROM daily_revenue WHERE date='2026-05-04'`).get() as any;
    expect(row).toEqual({ restaurant_id: "resto-1", date: "2026-05-04", amount: 123400 });
    const audit = rawDb.query(`SELECT source, action FROM audit_logs WHERE table_name='daily_revenue'`).get() as any;
    expect(audit).toEqual({ source: "bot:admin", action: "insert" });
  });

  test("LEAVE_APPROVE=false blocks admin holiday review", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/holidays/pending/latest", { headers: authHeaders("manager-no-leave") });

    expect(res.status).toBe(403);
  });

  test("admin can review a pending holiday and notify the worker", async () => {
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("hol-review", "worker-1", "resto-1", "2099-07-01", "2099-07-02", "vacances", "pending");

    const pending = await app.request("/internal/whatsapp/workers/worker-1/holidays/pending/latest", { headers: authHeaders("admin-1") });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ data: { request: { id: "hol-review", startDate: "2099-07-01", endDate: "2099-07-02" } } });

    const review = await app.request("/internal/whatsapp/holidays/hol-review/review", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) });
    expect(review.status).toBe(200);
    const row = rawDb.query(`SELECT status, reviewed_by FROM holiday_requests WHERE id='hol-review'`).get() as any;
    expect(row).toEqual({ status: "approved", reviewed_by: "admin-1" });
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE row_id='hol-review'`).get() as any;
    expect(audit.source).toBe("bot:admin");
    const notification = rawDb.query(`SELECT recipient_id, type FROM notifications WHERE recipient_id='worker-1'`).get() as any;
    expect(notification).toEqual({ recipient_id: "worker-1", type: "holiday_approved" });
  });

  test("admin can add an approved worker holiday", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/holidays", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ startDate: "2099-08-01", endDate: "2099-08-03", reason: "repos" }) });

    expect(res.status).toBe(201);
    const row = rawDb.query(`SELECT worker_id, status, source, reviewed_by, reason FROM holiday_requests WHERE worker_id='worker-1'`).get() as any;
    expect(row).toEqual({ worker_id: "worker-1", status: "approved", source: "admin_proposal", reviewed_by: "admin-1", reason: "repos" });
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE table_name='holiday_requests'`).get() as any;
    expect(audit.source).toBe("bot:admin");
  });

  test("admin can prepare replacement review prompts through API", async () => {
    insertUser("worker-3", "resto-1", "floor");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-prepare", "worker-1", "svc-1", "resto-1", "awaiting_admin_decision", "malade", "2099-01-01", JSON.stringify(["worker-3"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "pick", candidateName: "worker-3" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "pick_ready", replacementId: "repl-prepare", requesterName: "Alice Martin", pickedId: "worker-3", pickedName: "User worker-3", svcLabel: "2026-05-04 (10:00-14:00)" } });
  });

  test("replacement review preparation filters candidates by service role", async () => {
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-role-filter", "worker-1", "svc-1", "resto-1", "awaiting_admin_decision", "malade", "2099-01-01", JSON.stringify(["worker-2"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "pick", candidateName: "Bob" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "no_candidates", replacementId: "repl-role-filter" } });
  });

  test("replacement review prompt can resolve accepted shared candidates", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-shared", "worker-1", "svc-1", "resto-1", "awaiting_admin_decision", "malade", "2099-01-01", JSON.stringify(["foreign-worker"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "pick", candidateName: "foreign" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "pick_ready", replacementId: "repl-shared", pickedId: "foreign-worker", pickedName: "User foreign-worker" } });
  });

  test("replacement review preparation hides shared requesters for wrong-role services", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-repl-review-wrong-role", "foreign-worker", "resto-1", "2026-05-04", "10:00", "14:00", "kitchen", "scheduled",
    );
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "repl-wrong-role-requester", "foreign-worker", "foreign-target-repl-review-wrong-role", "resto-1", "awaiting_admin_decision", "besoin relais", "2099-01-01", JSON.stringify(["worker-1"]), JSON.stringify([]),
    );

    const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "refuse" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: "no_requests" } });
  });

  test("replacement broadcast preparation returns only live candidate ids", async () => {
    seedAcceptedShare();
    insertUser("worker-3", "resto-1", "floor");
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-foreign");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-filtered", "worker-1", "svc-1", "resto-1", "awaiting_admin_decision", "malade", "2099-01-01", JSON.stringify(["foreign-worker", "worker-3"]), JSON.stringify([]));

    const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "broadcast" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "broadcast_ready", candidateIds: ["worker-3"], candidateNames: ["User worker-3"] } });
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`replacement broadcast preparation hides stale accepted shared candidates when ${scenario.name}`, async () => {
      seedAcceptedShare();
      scenario.mutate();
      rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("repl-stale-shared", "worker-1", "svc-1", "resto-1", "awaiting_admin_decision", "malade", "2099-01-01", JSON.stringify(["foreign-worker"]), JSON.stringify([]));

      const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "broadcast" }) });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: { status: "no_candidates", replacementId: "repl-stale-shared" } });
    });
  }

  for (const scenario of staleAcceptedShareScenarios) {
    test(`replacement review preparation hides stale accepted shared requesters when ${scenario.name}`, async () => {
      seedAcceptedShare();
      rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "foreign-target-repl-review", "foreign-worker", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled",
      );
      rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, candidate_ids, rejected_candidate_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "repl-stale-requester", "foreign-worker", "foreign-target-repl-review", "resto-1", "awaiting_admin_decision", "besoin relais", "2099-01-01", JSON.stringify(["worker-1"]), JSON.stringify([]),
      );
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/replacements/review/prepare", { method: "POST", headers: { ...authHeaders("admin-1"), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "refuse" }) });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { status: "no_requests" } });
    });
  }

  test("TEAM_VIEW=false blocks pending requests", async () => {
    const res = await app.request("/internal/whatsapp/requests/pending", { headers: authHeaders("manager-no-team") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch pending requests", async () => {
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("hol-1", "worker-1", "resto-1", "2026-05-20", "2026-05-22", "vacances", "pending");
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("repl-1", "worker-1", "svc-1", "resto-1", "awaiting_admin_decision", "malade", "2099-01-01T00:00:00.000Z");

    const res = await app.request("/internal/whatsapp/requests/pending", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.holidays).toEqual([{ workerName: "Alice Martin", startDate: "2026-05-20", endDate: "2026-05-22", reason: "vacances" }]);
    expect(json.data.replacements).toEqual([{ requesterName: "Alice Martin", message: "malade", status: "awaiting_admin_decision" }]);
  });

  test("pending requests hide shared-worker leave but allow live target replacement summaries", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-repl-svc", "foreign-worker", "resto-1", "2026-05-04", "18:00", "23:00", "floor", "scheduled",
    );
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "hol-shared", "foreign-worker", "resto-1", "2026-05-20", "2026-05-22", "shared leave", "pending",
    );
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "repl-shared-requester", "foreign-worker", "foreign-target-repl-svc", "resto-1", "awaiting_admin_decision", "besoin relais", "2099-01-01T00:00:00.000Z",
    );

    const res = await app.request("/internal/whatsapp/requests/pending", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.holidays).toEqual([]);
    expect(json.data.replacements).toEqual([{ requesterName: "User foreign-worker", message: "besoin relais", status: "awaiting_admin_decision" }]);
  });

  test("pending requests hide shared-worker replacement summaries for wrong-role services", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-repl-wrong-role", "foreign-worker", "resto-1", "2026-05-04", "18:00", "23:00", "kitchen", "scheduled",
    );
    rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "repl-shared-wrong-role", "foreign-worker", "foreign-target-repl-wrong-role", "resto-1", "awaiting_admin_decision", "besoin relais", "2099-01-01T00:00:00.000Z",
    );

    const res = await app.request("/internal/whatsapp/requests/pending", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.replacements).toEqual([]);
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`pending requests hide stale shared-worker replacement summaries when ${scenario.name}`, async () => {
      seedAcceptedShare();
      rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "foreign-target-repl-svc", "foreign-worker", "resto-1", "2026-05-04", "18:00", "23:00", "floor", "scheduled",
      );
      rawDb.prepare(`INSERT INTO replacement_requests (id, requester_id, requester_service_id, restaurant_id, status, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "repl-shared-requester", "foreign-worker", "foreign-target-repl-svc", "resto-1", "awaiting_admin_decision", "besoin relais", "2099-01-01T00:00:00.000Z",
      );
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/requests/pending", { headers: authHeaders("manager-ok") });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.replacements).toEqual([]);
    });
  }

  test("TEAM_VIEW=false blocks team schedule", async () => {
    const res = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("manager-no-team") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch team schedule", async () => {
    const res = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.from).toBe("2026-05-04");
    expect(json.data.to).toBe("2026-05-10");
    expect(json.data.services).toHaveLength(2);
    expect(json.data.services[0].workerName).toBe("Alice Martin");
    expect(json.data.zones).toContain("Midi");
    expect(json.data.totalHours).toBe(9);
  });

  test("valid manager can fetch team on date", async () => {
    const res = await app.request("/internal/whatsapp/team/on-date?date=2026-05-04", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.date).toBe("2026-05-04");
    expect(json.data.services).toHaveLength(1);
    expect(json.data.services[0]).toMatchObject({ workerName: "Alice Martin", zone: "Midi" });
  });

  test("owner admin team schedule spans all restaurants in the owner account", async () => {
    const res = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("admin-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.scope).toBe("owner");
    expect(json.data.restaurants.map((r: { name: string }) => r.name).sort()).toEqual(["Resto 1", "Resto 2"]);
    expect(json.data.services.map((s: { id: string }) => s.id).sort()).toEqual(["foreign-svc", "svc-1", "svc-2"]);
    expect(json.data.services.find((s: { id: string }) => s.id === "foreign-svc")).toMatchObject({
      restaurantName: "Resto 2",
      workerName: "User foreign-worker",
    });
  });

  test("owner admin can resolve and view a worker scheduled in another restaurant", async () => {
    const resolved = await app.request("/internal/whatsapp/workers/resolve?name=foreign", { headers: authHeaders("admin-1") });
    expect(resolved.status).toBe(200);
    const resolvedJson = await resolved.json();
    expect(resolvedJson.data.worker).toMatchObject({
      id: "foreign-worker",
      name: "User foreign-worker",
      restaurantNames: ["Resto 2"],
    });

    const schedule = await app.request("/internal/whatsapp/workers/foreign-worker/schedule?date=2026-05-04", { headers: authHeaders("admin-1") });
    expect(schedule.status).toBe(200);
    const scheduleJson = await schedule.json();
    expect(scheduleJson.data.services).toHaveLength(1);
    expect(scheduleJson.data.services[0]).toMatchObject({ id: "foreign-svc", restaurantName: "Resto 2" });
  });

  test("team schedule views include shared-worker target services but ignore source services", async () => {
    seedAcceptedShare();

    const sourceOnlyWeek = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(sourceOnlyWeek.status).toBe(200);
    const sourceOnlyWeekJson = await sourceOnlyWeek.json();
    expect(sourceOnlyWeekJson.data.services).toHaveLength(2);
    expect(sourceOnlyWeekJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-svc");

    const sourceOnlyDay = await app.request("/internal/whatsapp/team/on-date?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(sourceOnlyDay.status).toBe(200);
    const sourceOnlyDayJson = await sourceOnlyDay.json();
    expect(sourceOnlyDayJson.data.services).toHaveLength(1);
    expect(sourceOnlyDayJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-svc");

    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-team", "foreign-worker", "resto-1", "2026-05-04", "18:00", "23:00", "floor", "scheduled",
    );

    const targetWeek = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(targetWeek.status).toBe(200);
    const targetWeekJson = await targetWeek.json();
    expect(targetWeekJson.data.services.map((s: { id: string }) => s.id)).toContain("foreign-target-team");
    expect(targetWeekJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-svc");
    expect(targetWeekJson.data.totalHours).toBe(14);

    const targetDay = await app.request("/internal/whatsapp/team/on-date?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(targetDay.status).toBe(200);
    const targetDayJson = await targetDay.json();
    expect(targetDayJson.data.services.map((s: { id: string }) => s.id)).toContain("foreign-target-team");
    expect(targetDayJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-svc");
  });

  test("team schedule derived views hide accepted-share target services with the wrong role", async () => {
    seedAcceptedShare();
    seedMidiFloorStaffingTarget();
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-wrong-role", "foreign-worker", "resto-1", "2026-05-04", "10:00", "14:00", "kitchen", "scheduled",
    );

    const schedule = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(schedule.status).toBe(200);
    const scheduleJson = await schedule.json();
    expect(scheduleJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-target-wrong-role");

    const onDate = await app.request("/internal/whatsapp/team/on-date?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(onDate.status).toBe(200);
    const onDateJson = await onDate.json();
    expect(onDateJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-target-wrong-role");

    const gap = await app.request("/internal/whatsapp/team/staffing-gap?date=2026-05-04&zone=Midi", { headers: authHeaders("manager-ok") });
    expect(gap.status).toBe(200);
    const gapJson = await gap.json();
    expect(gapJson.data.zones[0].floor).toEqual({ target: 2, actual: 1, missing: 1, workers: ["Alice Martin"] });
  });

  test("staffing gap counts shared-worker target services but ignores source services", async () => {
    seedAcceptedShare();
    seedMidiFloorStaffingTarget();

    const sourceOnly = await app.request("/internal/whatsapp/team/staffing-gap?date=2026-05-04&zone=Midi", { headers: authHeaders("manager-ok") });

    expect(sourceOnly.status).toBe(200);
    const sourceOnlyJson = await sourceOnly.json();
    expect(sourceOnlyJson.data.zones).toEqual([{
      zone: "Midi",
      kitchen: { target: 0, actual: 0, missing: 0, workers: [] },
      floor: { target: 2, actual: 1, missing: 1, workers: ["Alice Martin"] },
    }]);

    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-staffing", "foreign-worker", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled",
    );

    const targetCovered = await app.request("/internal/whatsapp/team/staffing-gap?date=2026-05-04&zone=Midi", { headers: authHeaders("manager-ok") });

    expect(targetCovered.status).toBe(200);
    const targetCoveredJson = await targetCovered.json();
    expect(targetCoveredJson.data.zones).toEqual([{
      zone: "Midi",
      kitchen: { target: 0, actual: 0, missing: 0, workers: [] },
      floor: { target: 2, actual: 2, missing: 0, workers: ["Alice Martin", "User foreign-worker"] },
    }]);
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`team schedule derived views hide stale target services when ${scenario.name}`, async () => {
      seedAcceptedShare();
      seedMidiFloorStaffingTarget();
      rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "foreign-target-stale-schedule", "foreign-worker", "resto-1", "2026-05-04", "10:00", "14:00", "floor", "scheduled",
      );
      scenario.mutate();

      const schedule = await app.request("/internal/whatsapp/team/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });
      expect(schedule.status).toBe(200);
      const scheduleJson = await schedule.json();
      expect(scheduleJson.data.services.map((s: { id: string }) => s.id)).not.toContain("foreign-target-stale-schedule");

      const gap = await app.request("/internal/whatsapp/team/staffing-gap?date=2026-05-04&zone=Midi", { headers: authHeaders("manager-ok") });
      expect(gap.status).toBe(200);
      const gapJson = await gap.json();
      expect(gapJson.data.zones[0].floor).toEqual({ target: 2, actual: 1, missing: 1, workers: ["Alice Martin"] });
    });
  }

  test("TEAM_VIEW=false blocks sending worker schedule", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/send-schedule", { method: "POST", headers: authHeaders("manager-no-team"), body: JSON.stringify({ date: "2026-05-04" }) });

    expect(res.status).toBe(403);
  });

  test("valid manager can send worker schedule", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/send-schedule", { method: "POST", headers: { ...authHeaders("manager-ok"), "Content-Type": "application/json" }, body: JSON.stringify({ date: "2026-05-04" }) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.sent).toBe(true);
    expect(json.data.serviceCount).toBe(2);
    const notification = rawDb.query(`SELECT recipient_id, type, message FROM notifications`).get() as any;
    expect(notification.recipient_id).toBe("worker-1");
    expect(notification.type).toBe("schedule_change");
    expect(notification.message).toContain("Planning de Alice Martin (2026-05-04 → 2026-05-10)");
  });

  test("shared worker send-schedule stays target-scoped and does not notify source-only services", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/workers/foreign-worker/send-schedule", {
      method: "POST",
      headers: { ...authHeaders("manager-ok"), "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-05-04" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({
      sent: false,
      serviceCount: 0,
      totalHours: 0,
      worker: {
        id: "foreign-worker",
        name: "User foreign-worker",
        sharedFromRestaurantId: "resto-2",
      },
    });
    expectWhatsappSharedRosterPrivacy(json.data.worker);
    expect(rawDb.query("SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = 'foreign-worker'").get()).toEqual({ count: 0 });
  });

  test("shared worker schedule endpoints hide wrong-role target services", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO published_weeks (id, restaurant_id, week_date) VALUES (?, ?, ?)`).run("published-wrong-role-week", "resto-1", "2099-05-04");
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-wrong-role-worker-view", "foreign-worker", "resto-1", "2099-05-04", "10:00", "14:00", "kitchen", "scheduled",
    );

    const managerView = await app.request("/internal/whatsapp/workers/foreign-worker/schedule?date=2099-05-04", { headers: authHeaders("manager-ok") });
    expect(managerView.status).toBe(200);
    const managerJson = await managerView.json();
    expect(managerJson.data.services).toEqual([]);
    expect(managerJson.data.totalHours).toBe(0);

    const send = await app.request("/internal/whatsapp/workers/foreign-worker/send-schedule", {
      method: "POST",
      headers: { ...authHeaders("manager-ok"), "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2099-05-04" }),
    });
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ data: { sent: false, serviceCount: 0, totalHours: 0 } });

    const ownHeaders = {
      ...authHeaders("foreign-worker"),
      "X-Comptoir-Restaurant-Id": "resto-1",
    };
    const ownSchedule = await app.request("/internal/whatsapp/me/schedule?date=2099-05-04", { headers: ownHeaders });
    expect(ownSchedule.status).toBe(200);
    expect(await ownSchedule.json()).toMatchObject({ data: { services: [], totalHours: 0 } });

    const ownHours = await app.request("/internal/whatsapp/me/hours?month=2099-05", { headers: ownHeaders });
    expect(ownHours.status).toBe(200);
    expect(await ownHours.json()).toMatchObject({ data: { services: [], serviceCount: 0, totalHours: 0 } });

    const next = await app.request("/internal/whatsapp/me/next-service", { headers: ownHeaders });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ data: { service: null } });
  });

  test("TEAM_VIEW=false blocks worker schedule", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/schedule?date=2026-05-04", { headers: authHeaders("manager-no-team") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch worker schedule with totals", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.worker.name).toBe("Alice Martin");
    expect(json.data.from).toBe("2026-05-04");
    expect(json.data.to).toBe("2026-05-10");
    expect(json.data.services).toHaveLength(2);
    expect(json.data.totalHours).toBe(9);
  });

  test("shared worker schedule stays scoped to the target restaurant without HR or contact fields", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/workers/foreign-worker/schedule?date=2026-05-04", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.worker).toMatchObject({
      id: "foreign-worker",
      name: "User foreign-worker",
      sharedFromRestaurantId: "resto-2",
    });
    expectWhatsappSharedRosterPrivacy(json.data.worker);
    expect(json.data.services).toEqual([]);
    expect(json.data.totalHours).toBe(0);
  });

  test("worker can fetch own schedule without TEAM_VIEW", async () => {
    const res = await app.request("/internal/whatsapp/me/schedule?date=2026-05-04", { headers: authHeaders("worker-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.from).toBe("2026-05-04");
    expect(json.data.to).toBe("2026-05-10");
    expect(json.data.services.map((s: { id: string }) => s.id)).toEqual(["svc-1", "svc-2"]);
    expect(json.data.services[0].zone).toBe("Midi");
    expect(json.data.totalHours).toBe(9);
  });

  test("worker own schedule includes services across restaurants in the same owner account", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "worker-1-resto-2", "worker-1", "resto-2", "2026-05-06", "10:00", "14:00", "floor", "scheduled",
    );

    const res = await app.request("/internal/whatsapp/me/schedule?date=2026-05-04", { headers: authHeaders("worker-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.services.map((s: { id: string }) => s.id)).toEqual(["svc-1", "svc-2", "worker-1-resto-2"]);
    expect(json.data.services[2]).toMatchObject({ restaurantName: "Resto 2" });
    expect(json.data.totalHours).toBe(13);
  });

  test("worker can fetch own next service", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "future-svc", "worker-1", "resto-1", "2099-01-05", "18:00", "23:00", "floor", "scheduled",
    );

    const res = await app.request("/internal/whatsapp/me/next-service", { headers: authHeaders("worker-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.service.date).toBe("2099-01-05");
    expect(json.data.service.zone).toBe("Soir");
  });

  test("TEAM_VIEW=false blocks compliance", async () => {
    const res = await app.request("/internal/whatsapp/team/compliance?date=2026-05-04", { headers: authHeaders("manager-no-team") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch compliance alerts", async () => {
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "svc-long", "worker-1", "resto-1", "2026-05-06", "08:00", "20:00", "floor", "scheduled",
    );

    const res = await app.request("/internal/whatsapp/team/compliance?date=2026-05-04", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.from).toBe("2026-05-04");
    expect(json.data.serviceCount).toBe(3);
    expect(json.data.alerts).toContain("🛑 Alice Martin: 12h le Mercredi 2026-05-06 (max 11h)");
  });

  test("compliance ignores shared-worker source services and checks target services only", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-source-long", "foreign-worker", "resto-2", "2026-05-06", "08:00", "20:00", "floor", "scheduled",
    );

    const sourceOnly = await app.request("/internal/whatsapp/team/compliance?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(sourceOnly.status).toBe(200);
    const sourceOnlyJson = await sourceOnly.json();
    expect(sourceOnlyJson.data.serviceCount).toBe(2);
    expect(sourceOnlyJson.data.alerts.join("\n")).not.toContain("User foreign-worker");

    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-long", "foreign-worker", "resto-1", "2026-05-07", "08:00", "20:00", "floor", "scheduled",
    );

    const target = await app.request("/internal/whatsapp/team/compliance?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(target.status).toBe(200);
    const targetJson = await target.json();
    expect(targetJson.data.serviceCount).toBe(3);
    expect(targetJson.data.alerts).toContain("🛑 User foreign-worker: 12h le Jeudi 2026-05-07 (max 11h)");
  });

  test("TEAM_VIEW=false blocks availability", async () => {
    const res = await app.request("/internal/whatsapp/team/availability?date=2026-05-04", { headers: authHeaders("manager-no-team") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch availability", async () => {
    rawDb.prepare(`INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir) VALUES (?, ?, ?, ?, ?, ?)`).run("avail-worker-2", "worker-2", "resto-1", 1, 0, 1);
    rawDb.prepare(`INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)`).run("hol-1", "manager-ok", "resto-1", "2026-05-04", "2026-05-04", "approved");

    const res = await app.request("/internal/whatsapp/team/availability?date=2026-05-04&zone=Midi", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.date).toBe("2026-05-04");
    expect(json.data.zones).toHaveLength(1);
    expect(json.data.zones[0].zone).toBe("Midi");
    expect(json.data.zones[0].alreadyScheduled).toContain("Alice Martin");
    expect(json.data.zones[0].unavailable).toContain("Bob Chef");
    expect(json.data.zones[0].unavailable).toContain("User manager-ok (congé)");
  });

  test("availability marks shared workers without target availability as requiring confirmation", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/team/availability?date=2026-05-04&zone=Soir", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.zones[0].available).not.toContain("User foreign-worker");
    expect(json.data.zones[0].unavailable).toContain("User foreign-worker (disponibilité à confirmer)");
  });

  test("availability treats source restaurant services as already scheduled for shared workers", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir) VALUES (?, ?, ?, ?, ?, ?)`).run("avail-foreign", "foreign-worker", "resto-1", 1, 1, 1);

    const res = await app.request("/internal/whatsapp/team/availability?date=2026-05-04&zone=Midi", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.zones[0].alreadyScheduled).toContain("User foreign-worker (ailleurs)");
    expect(json.data.zones[0].available).not.toContain("User foreign-worker");
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`availability hides stale accepted shared workers when ${scenario.name}`, async () => {
      seedAcceptedShare();
      rawDb.prepare(`INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir) VALUES (?, ?, ?, ?, ?, ?)`).run("avail-foreign", "foreign-worker", "resto-1", 1, 1, 1);
      scenario.mutate();

      const res = await app.request("/internal/whatsapp/team/availability?date=2026-05-04&zone=Soir", { headers: authHeaders("manager-ok") });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.zones[0].available).not.toContain("User foreign-worker");
      expect(json.data.zones[0].alreadyScheduled).not.toContain("User foreign-worker");
      expect(json.data.zones[0].alreadyScheduled).not.toContain("User foreign-worker (ailleurs)");
      expect(json.data.zones[0].unavailable).not.toContain("User foreign-worker");
      expect(json.data.zones[0].unavailable).not.toContain("User foreign-worker (disponibilité à confirmer)");
    });
  }

  test("HOURS_VIEW=false blocks weekly recap", async () => {
    const res = await app.request("/internal/whatsapp/team/weekly-recap?date=2026-05-04", { headers: authHeaders("manager-no-hours") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch weekly recap", async () => {
    const res = await app.request("/internal/whatsapp/team/weekly-recap?date=2026-05-04", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.from).toBe("2026-05-04");
    expect(json.data.to).toBe("2026-05-10");
    expect(json.data.serviceCount).toBe(2);
    expect(json.data.totalHours).toBe(9);
    expect(json.data.workers).toEqual([{ workerId: "worker-1", name: "Alice Martin", role: "floor", hours: 9, services: 2 }]);
  });

  test("weekly recap includes shared-worker target services but ignores source services", async () => {
    seedAcceptedShare();

    const sourceOnly = await app.request("/internal/whatsapp/team/weekly-recap?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(sourceOnly.status).toBe(200);
    const sourceOnlyJson = await sourceOnly.json();
    expect(sourceOnlyJson.data.serviceCount).toBe(2);
    expect(sourceOnlyJson.data.totalHours).toBe(9);
    expect(sourceOnlyJson.data.workers.map((w: { workerId: string }) => w.workerId)).not.toContain("foreign-worker");

    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-recap", "foreign-worker", "resto-1", "2026-05-06", "18:00", "23:00", "floor", "scheduled",
    );

    const target = await app.request("/internal/whatsapp/team/weekly-recap?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(target.status).toBe(200);
    const targetJson = await target.json();
    expect(targetJson.data.serviceCount).toBe(3);
    expect(targetJson.data.totalHours).toBe(14);
    expect(targetJson.data.workers).toEqual([
      { workerId: "worker-1", name: "Alice Martin", role: "floor", hours: 9, services: 2 },
      { workerId: "foreign-worker", name: "User foreign-worker", role: "floor", hours: 5, services: 1 },
    ]);
  });

  test("weekly recap and hours hide accepted-share target services with the wrong role", async () => {
    seedAcceptedShare();
    rawDb.prepare(`INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "foreign-target-wrong-role-recap", "foreign-worker", "resto-1", "2026-05-06", "18:00", "23:00", "kitchen", "scheduled",
    );

    const recap = await app.request("/internal/whatsapp/team/weekly-recap?date=2026-05-04", { headers: authHeaders("manager-ok") });
    expect(recap.status).toBe(200);
    const recapJson = await recap.json();
    expect(recapJson.data.serviceCount).toBe(2);
    expect(recapJson.data.workers.map((w: { workerId: string }) => w.workerId)).not.toContain("foreign-worker");

    const hours = await app.request("/internal/whatsapp/workers/foreign-worker/hours?period=2026-05", { headers: authHeaders("manager-ok") });
    expect(hours.status).toBe(200);
    expect(await hours.json()).toMatchObject({ data: { serviceCount: 0, totalHours: 0 } });
  });

  test("HOURS_VIEW=false blocks worker hours", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/hours?period=2026-05", { headers: authHeaders("manager-no-hours") });

    expect(res.status).toBe(403);
  });

  test("valid manager can fetch worker hours", async () => {
    const res = await app.request("/internal/whatsapp/workers/worker-1/hours?period=2026-05", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.worker.name).toBe("Alice Martin");
    expect(json.data.periodLabel).toBe("mai 2026");
    expect(json.data.serviceCount).toBe(2);
    expect(json.data.totalHours).toBe(9);
  });

  test("shared worker hours stay scoped to the target restaurant without HR or contact fields", async () => {
    seedAcceptedShare();

    const res = await app.request("/internal/whatsapp/workers/foreign-worker/hours?period=2026-05", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.worker).toMatchObject({
      id: "foreign-worker",
      name: "User foreign-worker",
      sharedFromRestaurantId: "resto-2",
    });
    expectWhatsappSharedRosterPrivacy(json.data.worker);
    expect(json.data.serviceCount).toBe(0);
    expect(json.data.totalHours).toBe(0);
  });

  test("shared worker clock-in uses the target restaurant service only", async () => {
    const previousDemoChatSecret = process.env.DEMO_CHAT_SECRET;
    process.env.DEMO_CHAT_SECRET = "";
    seedAcceptedShare();
    const today = todayInParis();
    rawDb.prepare("UPDATE restaurants SET tap_in_out_admin_confirmation = 1 WHERE id = ?").run("resto-1");
    rawDb.prepare(`
      INSERT OR REPLACE INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active)
      VALUES (?, ?, ?, ?, 1)
    `).run("resto-2", "admin-1", "admin", null);
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("foreign-target-clock", "foreign-worker", "resto-1", today, "09:00", "12:00", "floor", "scheduled");
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("foreign-source-clock", "foreign-worker", "resto-2", today, "09:00", "12:00", "floor", "scheduled");

    const headers = {
      ...authHeaders("foreign-worker"),
      "X-Comptoir-Restaurant-Id": "resto-1",
    };
    const clockIn = await app.request("/internal/whatsapp/me/clock-in", {
      method: "POST",
      headers,
    });

    expect(clockIn.status).toBe(201);
    const clockInBody = await clockIn.json();
    expect(clockInBody.data).toMatchObject({
      serviceId: "foreign-target-clock",
      date: today,
    });

    const clockOut = await app.request("/internal/whatsapp/me/clock-out", {
      method: "POST",
      headers,
    });
    expect(clockOut.status).toBe(200);

    const clockRows = rawDb.query(`
      SELECT user_id AS userId, restaurant_id AS restaurantId, service_id AS serviceId, tap_out AS tapOut
      FROM time_clocks
      WHERE user_id = ?
    `).all("foreign-worker") as any[];
    expect(clockRows).toHaveLength(1);
    expect(clockRows[0]).toMatchObject({
      userId: "foreign-worker",
      restaurantId: "resto-1",
      serviceId: "foreign-target-clock",
    });
    expect(clockRows[0].tapOut).toBeTruthy();

    const auditRows = rawDb.query(`
      SELECT restaurant_id AS restaurantId, table_name AS tableName, action, actor_id AS actorId, source
      FROM audit_logs
      WHERE table_name = 'time_clocks'
      ORDER BY created_at, action
    `).all() as any[];
    expect(auditRows).toEqual([
      {
        restaurantId: "resto-1",
        tableName: "time_clocks",
        action: "insert",
        actorId: "foreign-worker",
        source: "bot:worker",
      },
      {
        restaurantId: "resto-1",
        tableName: "time_clocks",
        action: "update",
        actorId: "foreign-worker",
        source: "bot:worker",
      },
    ]);
    const notification = rawDb.query(`
      SELECT recipient_id AS recipientId, type, message
      FROM notifications
      WHERE type = 'time_clock_confirm'
    `).get() as any;
    expect(notification).toMatchObject({
      recipientId: "admin-1",
      type: "time_clock_confirm",
    });
    expect(notification.message.startsWith("*Resto 1*\nUser foreign-worker a pointé son arrivée")).toBe(true);
    if (previousDemoChatSecret === undefined) {
      delete process.env.DEMO_CHAT_SECRET;
    } else {
      process.env.DEMO_CHAT_SECRET = previousDemoChatSecret;
    }
  });

  test("shared worker clock-in ignores wrong-role target services", async () => {
    seedAcceptedShare();
    const today = todayInParis();
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("foreign-target-clock-wrong-role", "foreign-worker", "resto-1", today, "09:00", "12:00", "kitchen", "scheduled");

    const clockIn = await app.request("/internal/whatsapp/me/clock-in", {
      method: "POST",
      headers: {
        ...authHeaders("foreign-worker"),
        "X-Comptoir-Restaurant-Id": "resto-1",
      },
    });

    expect(clockIn.status).toBe(201);
    const clockInBody = await clockIn.json();
    expect(clockInBody.data.serviceId).toBeNull();
    const clock = rawDb.query(`SELECT service_id AS serviceId FROM time_clocks WHERE user_id = ?`).get("foreign-worker") as any;
    expect(clock).toEqual({ serviceId: null });
  });

  test("foreign worker IDs do not leak data", async () => {
    const res = await app.request("/internal/whatsapp/workers/foreign-worker/hours?period=2026-05", { headers: authHeaders("manager-ok") });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Worker not found" });
  });
});
