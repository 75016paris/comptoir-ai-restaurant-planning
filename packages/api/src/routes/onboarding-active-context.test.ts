import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-onboarding-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { onboardingRoutes } = await import("./onboarding.js");

const app = new Hono();
app.route("/onboarding", onboardingRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS staffing_profiles;
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
      open_days TEXT NOT NULL DEFAULT '[]',
      color_scheme TEXT NOT NULL DEFAULT 'classic',
      kitchen_sub_roles TEXT NOT NULL DEFAULT '[]',
      floor_sub_roles TEXT NOT NULL DEFAULT '[]',
      default_contract_type TEXT NOT NULL DEFAULT 'CDI',
      default_contract_hours INTEGER NOT NULL DEFAULT 35,
      preferred_style TEXT NOT NULL DEFAULT 'equipe-stable',
      subrole_hcr_map TEXT NOT NULL DEFAULT '{}',
      cache_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
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
      sub_role TEXT,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      overtime_willing INTEGER NOT NULL DEFAULT 0,
      coupure_willing INTEGER NOT NULL DEFAULT 0,
      contract_type TEXT,
      contract_hours INTEGER,
      contract_end_date TEXT,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      inactive_from TEXT,
      inactive_until TEXT,
      hcr_level TEXT,
      hourly_rate INTEGER,
      rate_effective_from TEXT,
      matricule TEXT,
      manager_notes TEXT,
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE owner_memberships (
      owner_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, user_id)
    );

    CREATE TABLE restaurant_memberships (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

    CREATE TABLE staffing_profiles (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo", null);
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status, onboarding_completed_at) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo", null);

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1, null, 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);
});

describe("onboarding routes active restaurant context", () => {
  test("POST /onboarding/employees creates visible restaurant memberships and worker profiles", async () => {
    const res = await app.request("/onboarding/employees", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        employees: [{
          name: "New Floor",
          email: "new-floor@example.com",
          phone: "+33611111111",
          role: "floor",
          subRoles: ["Serveur"],
          contractType: "CDI",
          contractHours: 35,
        }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.created).toHaveLength(1);

    const user = rawDb.query(`
      SELECT id, restaurant_id AS restaurantId
      FROM users
      WHERE email = ?
    `).get("new-floor@example.com") as { id: string; restaurantId: string };
    expect(user.restaurantId).toBe("a2");

    const membership = rawDb.query(`
      SELECT restaurant_id AS restaurantId, role, active
      FROM restaurant_memberships
      WHERE user_id = ?
    `).get(user.id);
    expect(membership).toEqual({ restaurantId: "a2", role: "floor", active: 1 });

    const profile = rawDb.query(`
      SELECT restaurant_id AS restaurantId, sub_roles AS subRoles, contract_hours AS contractHours
      FROM worker_restaurant_profiles
      WHERE user_id = ?
    `).get(user.id);
    expect(profile).toEqual({ restaurantId: "a2", subRoles: JSON.stringify(["Serveur"]), contractHours: 35 });

    const state = await app.request("/onboarding/state", {
      headers: { cookie: "session=session-a" },
    });
    expect(state.status).toBe(200);
    const stateBody = await state.json();
    expect(stateBody.data.counts.employees).toBe(1);
  });

  test("POST /onboarding/complete marks only the active restaurant as complete", async () => {
    const res = await app.request("/onboarding/complete", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });

    const rows = rawDb.query(`
      SELECT id, onboarding_completed_at AS onboardingCompletedAt
      FROM restaurants
      ORDER BY id
    `).all() as Array<{ id: string; onboardingCompletedAt: string | null }>;

    expect(rows[0]).toEqual({ id: "a1", onboardingCompletedAt: null });
    expect(rows[1].id).toBe("a2");
    expect(rows[1].onboardingCompletedAt).toEqual(expect.any(String));
  });
});
