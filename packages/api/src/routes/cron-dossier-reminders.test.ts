import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-cron-dossier-reminders-test-")), "test.db");
const previousCronSecret = process.env.CRON_SECRET;
const previousDemoChatSecret = process.env.DEMO_CHAT_SECRET;
const previousSmtpHost = process.env.SMTP_HOST;
const previousSmtpUser = process.env.SMTP_USER;
const previousSmtpPass = process.env.SMTP_PASS;
process.env.CRON_SECRET = "cron-secret";
delete process.env.DEMO_CHAT_SECRET;
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { rawDb } = await import("../db/connection.js");
const { cronRoutes } = await import("./cron.js");

const app = new Hono();
app.route("/cron", cronRoutes);

afterAll(() => {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
  if (previousDemoChatSecret === undefined) delete process.env.DEMO_CHAT_SECRET;
  else process.env.DEMO_CHAT_SECRET = previousDemoChatSecret;
  if (previousSmtpHost === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = previousSmtpHost;
  if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
  else process.env.SMTP_USER = previousSmtpUser;
  if (previousSmtpPass === undefined) delete process.env.SMTP_PASS;
  else process.env.SMTP_PASS = previousSmtpPass;
});

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  delete process.env.DEMO_CHAT_SECRET;
  createSchema();
  seedRestaurants();
});

describe("cron dossier reminders", () => {
  test("uses direct restaurant memberships instead of accepted share authorizations", async () => {
    insertWorker("worker-a1", "Worker A1", "a1");
    insertWorker("worker-a2", "Worker A2", "a2");
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, multi_restaurant_willing)
      VALUES (?, ?, ?, ?, ?)
    `).run("a2", "worker-a1", 1, "[]", 1);
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("share-a1-a2", "owner-a", "a1", "a2", "worker-a1", "floor", "accepted", "admin-a", "2026-05-01T10:00:00.000Z");

    const res = await app.request("/cron/dossier-reminders", {
      method: "POST",
      headers: { "X-Cron-Secret": "cron-secret" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: 2, pinged: 2, skippedComplete: 0, failed: 0 });

    const tokens = rawDb.query(`
      SELECT user_id AS userId, restaurant_id AS restaurantId
      FROM onboarding_tokens
      ORDER BY user_id, restaurant_id
    `).all();
    expect(tokens).toEqual([
      { userId: "worker-a1", restaurantId: "a1" },
      { userId: "worker-a2", restaurantId: "a2" },
    ]);

    const notifications = rawDb.query(`
      SELECT recipient_id AS recipientId, message
      FROM notifications
      ORDER BY recipient_id
    `).all() as Array<{ recipientId: string; message: string }>;
    expect(notifications.map((row) => row.recipientId)).toEqual(["worker-a1", "worker-a2"]);
    expect(notifications.find((row) => row.recipientId === "worker-a1")?.message).toContain("Alpha");
    expect(notifications.find((row) => row.recipientId === "worker-a1")?.message).not.toContain("Beta");
  });
});

function seedRestaurants() {
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "active");
  rawDb.prepare("INSERT INTO users (id, name, email, phone, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("admin-a", "Admin A", "admin@example.com", "+33600000000", "admin", "a1", 1);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
}

function insertWorker(id: string, name: string, restaurantId: string) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active,
      address, iban, emergency_contact, emergency_phone, date_of_birth, birth_place, nationality, nir
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `).run(id, name, `${id}@example.com`, `+336${id.length}000000`, "floor", restaurantId, 1);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", id, "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run(restaurantId, id, "floor", null, 1);
}

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS cron_runs;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS onboarding_tokens;
    DROP TABLE IF EXISTS documents;
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
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      address TEXT,
      iban TEXT,
      emergency_contact TEXT,
      emergency_phone TEXT,
      date_of_birth TEXT,
      birth_place TEXT,
      nationality TEXT,
      nir TEXT,
      last_dossier_reminder_at TEXT
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
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      requirement_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      issued_at TEXT,
      expires_at TEXT,
      reviewed_at TEXT
    );
    CREATE TABLE onboarding_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restaurant_id TEXT,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
    CREATE TABLE cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER,
      error TEXT,
      result TEXT
    );
  `);
}
