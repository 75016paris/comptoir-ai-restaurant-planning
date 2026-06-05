import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-public-onboarding-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { publicOnboardingRoutes } = await import("./public-onboarding.js");

const app = new Hono();
app.route("/public/onboarding", publicOnboardingRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS onboarding_tokens;
    DROP TABLE IF EXISTS restaurant_memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    PRAGMA foreign_keys = ON;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
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
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      contract_end_date TEXT,
      hcr_level TEXT,
      hourly_rate INTEGER,
      rate_effective_from TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      inactive_from TEXT,
      inactive_until TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      user_notice_version TEXT,
      user_notice_accepted_at TEXT,
      user_notice_ip_address TEXT,
      user_notice_user_agent TEXT,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
      whatsapp_opt_in_at TEXT,
      whatsapp_opt_out_at TEXT,
      last_dossier_reminder_at TEXT,
      permissions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE restaurant_memberships (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (restaurant_id, user_id)
    );

    CREATE TABLE onboarding_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restaurant_id TEXT,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run("a1", "Alpha");
  rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run("a2", "Beta");
  rawDb.prepare(`
    INSERT INTO users (
      id, name, first_name, last_name, email, phone, password_hash, role, restaurant_id, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "worker-shared",
    "Worker Shared",
    "Worker",
    "Shared",
    "worker@example.com",
    "+33600000001",
    "hash",
    "floor",
    "a1",
    1,
  );
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("a2", "worker-shared", "floor", 1);
  rawDb.prepare("INSERT INTO onboarding_tokens (id, user_id, restaurant_id, token, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run("token-1", "worker-shared", null, "raw-token", new Date(Date.now() + 60_000).toISOString());
});

describe("public onboarding active restaurant context", () => {
  test("legacy tokens with no restaurant_id use the single active membership before users.restaurant_id", async () => {
    const res = await app.request("/public/onboarding/raw-token");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.restaurantName).toBe("Beta");
  });

  test("legacy tokens with ambiguous memberships fail closed when legacy restaurant is not active", async () => {
    rawDb.prepare("INSERT INTO restaurants (id, name) VALUES (?, ?)").run("a3", "Gamma");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("a3", "worker-shared", "floor", 1);

    const res = await app.request("/public/onboarding/raw-token");

    expect(res.status).toBe(409);
  });

  test("restaurant-scoped tokens fail closed when the worker no longer belongs to that restaurant", async () => {
    rawDb.prepare("UPDATE onboarding_tokens SET restaurant_id = ? WHERE id = ?").run("a1", "token-1");

    const res = await app.request("/public/onboarding/raw-token");

    expect(res.status).toBe(409);
  });
});
