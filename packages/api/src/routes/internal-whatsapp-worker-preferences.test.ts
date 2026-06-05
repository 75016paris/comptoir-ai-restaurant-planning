import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetSqliteTables } from "../test/sqlite-reset.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-internal-wa-worker-prefs-test-")), "test.db");
process.env.WHATSAPP_INTERNAL_API_SECRET = "test-secret";

const { rawDb } = await import("../db/connection.js");
const { internalWhatsappRoutes } = await import("./internal-whatsapp.js");

rawDb.exec(`
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS audit_logs;
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
  CREATE TABLE restaurants (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', status TEXT NOT NULL DEFAULT 'active', subscription_status TEXT NOT NULL DEFAULT 'active', cache_version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, role TEXT NOT NULL, restaurant_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, permissions TEXT, must_change_password INTEGER NOT NULL DEFAULT 0, contract_hours INTEGER DEFAULT 35, max_weekly_hours INTEGER, coupure_willing INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE owner_memberships (owner_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (owner_id, user_id));
  CREATE TABLE restaurant_memberships (restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, permissions TEXT, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (restaurant_id, user_id));
  CREATE TABLE worker_restaurant_profiles (restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1, sub_roles TEXT NOT NULL DEFAULT '[]', contract_hours INTEGER, max_weekly_hours INTEGER, multi_restaurant_willing INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (restaurant_id, user_id));
  CREATE TABLE worker_share_authorizations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_restaurant_id TEXT NOT NULL, target_restaurant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', invited_by_user_id TEXT NOT NULL, worker_consented_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE worker_preferred_schedule (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, restaurant_id TEXT NOT NULL, day_of_week INTEGER NOT NULL, midi INTEGER NOT NULL DEFAULT 0, soir INTEGER NOT NULL DEFAULT 0, zones TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, restaurant_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, changes TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const app = new Hono();
app.route("/internal/whatsapp", internalWhatsappRoutes);
const headers = (userId: string, restaurantId?: string) => ({
  "Content-Type": "application/json",
  "X-WhatsApp-Internal-Secret": "test-secret",
  "X-Comptoir-User-Id": userId,
  ...(restaurantId ? { "X-Comptoir-Restaurant-Id": restaurantId } : {}),
});

beforeEach(() => {
  resetSqliteTables(rawDb);
  rawDb.prepare(`INSERT INTO owners (id, name) VALUES (?, ?)`).run("owner-1", "Owner One");
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, cache_version) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("resto-1", "owner-1", "Resto", "Europe/Paris", "active", "active", 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, phone, role, restaurant_id, active, permissions, contract_hours, max_weekly_hours, coupure_willing) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`).run("worker-1", "Worker One", "worker@example.com", "+3361", "floor", "resto-1", 35, null, 0);
  rawDb.prepare(`INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)`).run("owner-1", "worker-1", "member");
  rawDb.prepare(`INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)`).run("resto-1", "worker-1", "floor", 1);
  rawDb.prepare(`INSERT INTO worker_preferred_schedule (id, worker_id, restaurant_id, day_of_week, midi, soir, zones) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("pref-1", "worker-1", "resto-1", 1, 1, 0, "{}");
});

function seedAcceptedTargetShare() {
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, cache_version) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("resto-2", "owner-1", "Target", "Europe/Paris", "active", "active", 0);
  rawDb.prepare(`INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("resto-2", "worker-1", 1, "[]", 20, 28, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-1", "owner-1", "resto-1", "resto-2", "worker-1", "floor", "accepted", "worker-1", "2099-01-01T00:00:00.000Z");
  rawDb.prepare(`INSERT INTO worker_preferred_schedule (id, worker_id, restaurant_id, day_of_week, midi, soir, zones) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("pref-target-1", "worker-1", "resto-2", 2, 0, 1, "{}");
}

describe("internal WhatsApp worker preferences endpoints", () => {
  test("worker can fetch own preferences", async () => {
    const res = await app.request("/internal/whatsapp/me/preferences", { headers: headers("worker-1") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.contractHours).toBe(35);
    expect(json.data.maxWeeklyHours).toBeNull();
    expect(json.data.coupureWilling).toBe(false);
    expect(json.data.slots).toEqual([{ dayOfWeek: 1, midi: true, soir: false }]);
  });

  test("worker can update max hours, coupures, and slots", async () => {
    const res = await app.request("/internal/whatsapp/me/preferences", {
      method: "POST",
      headers: headers("worker-1"),
      body: JSON.stringify({ maxWeeklyHours: 42, coupureWilling: true, slotsByDay: { monday: { soir: true }, sunday: { closed: true } } }),
    });

    expect(res.status).toBe(200);
    const user = rawDb.query(`SELECT max_weekly_hours, coupure_willing FROM users WHERE id='worker-1'`).get() as any;
    expect(user).toEqual({ max_weekly_hours: 42, coupure_willing: 1 });
    const slots = rawDb.query(`SELECT day_of_week, midi, soir FROM worker_preferred_schedule ORDER BY day_of_week`).all() as any[];
    expect(slots).toEqual([{ day_of_week: 1, midi: 1, soir: 1 }, { day_of_week: 7, midi: 0, soir: 0 }]);
    const audit = rawDb.query(`SELECT source FROM audit_logs WHERE table_name='users'`).get() as any;
    expect(audit.source).toBe("bot:worker");
    const restaurant = rawDb.query(`SELECT cache_version FROM restaurants WHERE id='resto-1'`).get() as any;
    expect(restaurant.cache_version).toBe(1);
  });

  test("invalid hours are rejected", async () => {
    const res = await app.request("/internal/whatsapp/me/preferences", {
      method: "POST",
      headers: headers("worker-1"),
      body: JSON.stringify({ maxWeeklyHours: 100 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Heures max hors limites");
  });

  test("accepted shared workers read target restaurant profile preferences", async () => {
    seedAcceptedTargetShare();

    const res = await app.request("/internal/whatsapp/me/preferences", { headers: headers("worker-1", "resto-2") });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.contractHours).toBe(20);
    expect(json.data.maxWeeklyHours).toBe(28);
    expect(json.data.coupureWilling).toBe(false);
    expect(json.data.slots).toEqual([{ dayOfWeek: 2, midi: false, soir: true }]);
  });

  test("accepted shared workers update target max hours without mutating source user hours", async () => {
    seedAcceptedTargetShare();

    const res = await app.request("/internal/whatsapp/me/preferences", {
      method: "POST",
      headers: headers("worker-1", "resto-2"),
      body: JSON.stringify({ maxWeeklyHours: 30, slotsByDay: { wednesday: { midi: true } } }),
    });

    expect(res.status).toBe(200);
    const user = rawDb.query(`SELECT max_weekly_hours FROM users WHERE id='worker-1'`).get() as any;
    expect(user.max_weekly_hours).toBeNull();
    const profile = rawDb.query(`SELECT max_weekly_hours FROM worker_restaurant_profiles WHERE restaurant_id='resto-2' AND user_id='worker-1'`).get() as any;
    expect(profile.max_weekly_hours).toBe(30);
    const sourceSlots = rawDb.query(`SELECT day_of_week, midi, soir FROM worker_preferred_schedule WHERE restaurant_id='resto-1' ORDER BY day_of_week`).all() as any[];
    expect(sourceSlots).toEqual([{ day_of_week: 1, midi: 1, soir: 0 }]);
    const targetSlots = rawDb.query(`SELECT day_of_week, midi, soir FROM worker_preferred_schedule WHERE restaurant_id='resto-2' ORDER BY day_of_week`).all() as any[];
    expect(targetSlots).toEqual([{ day_of_week: 2, midi: 0, soir: 1 }, { day_of_week: 3, midi: 1, soir: 0 }]);
  });
});
