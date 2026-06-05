import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-settings-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { settingsRoutes } = await import("./settings.js");

const app = new Hono();
app.route("/settings", settingsRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS restaurant_closures;
    DROP TABLE IF EXISTS sessions;
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
      open_days TEXT NOT NULL DEFAULT '[2,3,4,5,6,7]',
      medical_mode INTEGER NOT NULL DEFAULT 0,
      worker_preferences_enabled INTEGER NOT NULL DEFAULT 1,
      tap_in_out_enabled INTEGER NOT NULL DEFAULT 0,
      color_scheme TEXT NOT NULL DEFAULT 'classic',
      kitchen_color TEXT NOT NULL DEFAULT 'amber',
      floor_color TEXT NOT NULL DEFAULT 'sky',
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE restaurant_closures (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      schedule TEXT
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare(`
    INSERT INTO restaurants (
      id, owner_id, name, status, open_days, medical_mode,
      worker_preferences_enabled, tap_in_out_enabled, color_scheme, kitchen_color, floor_color
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("a1", "owner-a", "Alpha", "demo", '{"1":"midi"}', 0, 0, 0, "classic", "amber", "sky");
  rawDb.prepare(`
    INSERT INTO restaurants (
      id, owner_id, name, status, open_days, medical_mode,
      worker_preferences_enabled, tap_in_out_enabled, color_scheme, kitchen_color, floor_color
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("a2", "owner-a", "Beta", "demo", '{"2":"soir"}', 1, 1, 1, "garden", "lime", "rose");

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin-a@example.com", "admin", "a1", 1, null, 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare("INSERT INTO restaurant_closures (id, restaurant_id, start_date, end_date, reason, schedule) VALUES (?, ?, ?, ?, ?, ?)")
    .run("closure-a1", "a1", "2026-06-01", "2026-06-02", "A1", null);
  rawDb.prepare("INSERT INTO restaurant_closures (id, restaurant_id, start_date, end_date, reason, schedule) VALUES (?, ?, ?, ?, ?, ?)")
    .run("closure-a2", "a2", "2026-07-01", "2026-07-02", "A2", '{"1":"closed"}');
});

describe("settings read routes active restaurant context", () => {
  test("read settings from the active restaurant instead of legacy users.restaurant_id", async () => {
    const openDays = await app.request("/settings/open-days", {
      headers: { cookie: "session=session-a" },
    });
    expect(openDays.status).toBe(200);
    expect(await openDays.json()).toEqual({ data: { "2": "soir" } });

    const medicalMode = await app.request("/settings/medical-mode", {
      headers: { cookie: "session=session-a" },
    });
    expect(medicalMode.status).toBe(200);
    expect(await medicalMode.json()).toEqual({ data: true });

    const workerConfig = await app.request("/settings/worker-config", {
      headers: { cookie: "session=session-a" },
    });
    expect(workerConfig.status).toBe(200);
    expect(await workerConfig.json()).toEqual({
      data: {
        workerPreferencesEnabled: true,
        tapInOutEnabled: true,
        colorScheme: "garden",
        kitchenColor: "lime",
        floorColor: "rose",
      },
    });

    const closures = await app.request("/settings/closures", {
      headers: { cookie: "session=session-a" },
    });
    expect(closures.status).toBe(200);
    expect(await closures.json()).toEqual({
      data: [{
        id: "closure-a2",
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        reason: "A2",
        schedule: { "1": "closed" },
      }],
    });
  });

  test("write settings update the active restaurant instead of legacy users.restaurant_id", async () => {
    const openDays = await app.request("/settings/open-days", {
      method: "PUT",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ "3": "midi" }),
    });
    expect(openDays.status).toBe(200);

    const medicalMode = await app.request("/settings/medical-mode", {
      method: "PUT",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(medicalMode.status).toBe(200);

    const rows = rawDb.query("SELECT id, open_days, medical_mode, cache_version FROM restaurants ORDER BY id").all() as any[];
    expect(rows).toEqual([
      { id: "a1", open_days: '{"1":"midi"}', medical_mode: 0, cache_version: 0 },
      { id: "a2", open_days: '{"3":"midi"}', medical_mode: 0, cache_version: 1 },
    ]);
  });
});
