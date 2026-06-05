import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-demo-chat-active-context-test-")), "test.db");
process.env.DEMO_CHAT_SECRET = "demo-chat-secret";

const { rawDb } = await import("../db/connection.js");
const { demoChatRoutes } = await import("./demo-chat.js");

const app = new Hono();
app.route("/demo-chat", demoChatRoutes);

const originalFetch = globalThis.fetch;

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
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
      onboarding_completed_at TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
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
  `);
}

function insertUser(id: string, name: string, role: string, legacyRestaurantId: string, phone: string) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 0)
  `).run(id, name, `${id}@example.com`, phone, role, legacyRestaurantId);
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("demo-a", "owner-a", "Demo A", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("legacy-home", "owner-a", "Legacy Home", "demo");

  insertUser("admin-a", "Admin A", "admin", "demo-a", "+33600000001");
  insertUser("worker-shared", "Shared Worker", "floor", "legacy-home", "+33600000002");
  insertUser("worker-legacy", "Legacy Worker", "floor", "legacy-home", "+33600000003");

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, 1)")
    .run("demo-a", "admin-a", "admin", null);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, 1)")
    .run("demo-a", "worker-shared", "floor", null);

  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "demo-a", new Date(Date.now() + 60_000).toISOString());
});

describe("demo chat active restaurant context", () => {
  test("GET /phones lists active restaurant members instead of legacy users.restaurant_id", async () => {
    const res = await app.request("/demo-chat/phones", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        admin: { name: "Admin A", phone: "+33600000001", role: "admin" },
        worker1: { name: "Shared Worker", phone: "+33600000002", role: "floor" },
        worker2: null,
      },
    });
  });

  test("GET /notifications forwards the active restaurant to the WhatsApp bot", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ data: { notifications: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await app.request("/demo-chat/notifications?phone=%2B33600000002&since=2026-05-21T10%3A00%3A00.000Z", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const url = new URL(seenUrl);
    expect(url.pathname).toBe("/chat/notifications");
    expect(url.searchParams.get("phone")).toBe("+33600000002");
    expect(url.searchParams.get("since")).toBe("2026-05-21T10:00:00.000Z");
    expect(url.searchParams.get("restaurantId")).toBe("demo-a");
  });

  test("POST /clear forwards the active restaurant to the WhatsApp bot", async () => {
    let seenBody: unknown = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await app.request("/demo-chat/clear", {
      method: "POST",
      headers: { cookie: "session=session-a", "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+33600000002" }),
    });

    expect(res.status).toBe(200);
    expect(seenBody).toEqual({ phone: "+33600000002", restaurantId: "demo-a" });
  });
});
