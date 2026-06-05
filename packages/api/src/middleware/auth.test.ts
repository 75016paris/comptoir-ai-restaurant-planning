import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "./auth.js";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-auth-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { requireAuth, requireActiveSubscription } = await import("./auth.js");
const { OWNER_LEGAL_VERSIONS, USER_NOTICE_VERSION } = await import("../services/legal-acceptance.js");

rawDb.exec(`
  DROP TABLE IF EXISTS legal_acceptances;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS restaurants;
  DROP TABLE IF EXISTS owners;

  CREATE TABLE owners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subscription_status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE restaurants (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL,
    subscription_status TEXT NOT NULL
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
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE legal_acceptances (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    restaurant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    acceptance_type TEXT NOT NULL,
    terms_version TEXT NOT NULL,
    dpa_version TEXT NOT NULL,
    privacy_version TEXT NOT NULL,
    subprocessors_version TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const app = new Hono<AppEnv>();
app.use("*", requireAuth);
app.get("/services", (c) => c.json({ data: { ok: true } }));
app.patch("/users/me/password", (c) => c.json({ data: { ok: true, userId: c.get("user").id } }));
app.post("/auth/legal/accept-user-notice", (c) => c.json({ data: { ok: true, userId: c.get("user").id } }));

const subscriptionApp = new Hono<AppEnv>();
subscriptionApp.use("*", requireAuth);
subscriptionApp.use("*", requireActiveSubscription);
subscriptionApp.get("/calendar", (c) => c.json({ data: { ok: true } }));

beforeEach(() => {
  rawDb.exec("DELETE FROM legal_acceptances; DELETE FROM sessions; DELETE FROM users; DELETE FROM restaurants; DELETE FROM owners;");
  rawDb.prepare(`INSERT INTO owners (id, name, subscription_status) VALUES (?, ?, ?)`)
    .run("owner-1", "Owner", "active");
  rawDb.prepare(`INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("resto-1", "owner-1", "Test", "Europe/Paris", "active", "active");
  rawDb.prepare(`INSERT INTO users (id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("needs-change", "Needs Change", "change@example.com", "floor", "resto-1", 1, null, 1, null, null, 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("normal", "Normal", "normal@example.com", "floor", "resto-1", 1, null, 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);
  rawDb.prepare(`INSERT INTO users (id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("manager", "Manager", "manager@example.com", "manager", "resto-1", 1, null, 0, USER_NOTICE_VERSION, "2026-05-11T00:00:00.000Z", 1);
  rawDb.prepare(`INSERT INTO users (id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("unaccepted", "Unaccepted", "unaccepted@example.com", "floor", "resto-1", 1, null, 0, null, null, 0);
  rawDb.prepare(`INSERT INTO users (id, name, email, role, restaurant_id, active, permissions, must_change_password, user_notice_version, user_notice_accepted_at, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("admin", "Admin", "admin@example.com", "admin", "resto-1", 1, null, 0, null, null, 0);
  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run("session-change", "needs-change", future);
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run("session-normal", "normal", future);
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run("session-manager", "manager", future);
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run("session-unaccepted", "unaccepted", future);
  rawDb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run("session-admin", "admin", future);
});

describe("requireAuth password-change gate", () => {
  test("blocks mustChangePassword users from normal protected routes", async () => {
    const res = await app.request("/services", { headers: { cookie: "session=session-change" } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Changement de mot de passe requis", code: "PASSWORD_CHANGE_REQUIRED" });
  });

  test("allows mustChangePassword users to change their password", async () => {
    const res = await app.request("/users/me/password", {
      method: "PATCH",
      headers: { cookie: "session=session-change" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, userId: "needs-change" } });
  });

  test("allows normal users through protected routes", async () => {
    const res = await app.request("/services", { headers: { cookie: "session=session-normal" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });
});

describe("requireAuth user notice acceptance gate", () => {
  test("blocks workers until current user notice is accepted", async () => {
    const res = await app.request("/services", { headers: { cookie: "session=session-unaccepted" } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Acceptation de la notice utilisateur requise", code: "USER_NOTICE_ACCEPTANCE_REQUIRED" });
  });

  test("allows workers to accept the user notice", async () => {
    const res = await app.request("/auth/legal/accept-user-notice", {
      method: "POST",
      headers: { cookie: "session=session-unaccepted" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, userId: "unaccepted" } });
  });

  test("does not block demo restaurant workers", async () => {
    rawDb.prepare("UPDATE restaurants SET status = ? WHERE id = ?").run("demo", "resto-1");

    const res = await app.request("/services", { headers: { cookie: "session=session-unaccepted" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });
});

describe("requireAuth owner legal acceptance gate", () => {
  test("blocks active restaurant admins until owner legal terms are accepted", async () => {
    const res = await app.request("/services", { headers: { cookie: "session=session-admin" } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Acceptation des conditions légales requise", code: "OWNER_LEGAL_ACCEPTANCE_REQUIRED" });
  });

  test("does not block managers for owner legal terms because they are not customer legal signatories", async () => {
    const res = await app.request("/services", { headers: { cookie: "session=session-manager" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  test("allows admins after current owner legal terms are accepted", async () => {
    rawDb.prepare(`
      INSERT INTO legal_acceptances (id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legal-1", "resto-1", "admin", "owner_terms", OWNER_LEGAL_VERSIONS.terms, OWNER_LEGAL_VERSIONS.dpa, OWNER_LEGAL_VERSIONS.privacy, OWNER_LEGAL_VERSIONS.subprocessors);

    const res = await app.request("/services", { headers: { cookie: "session=session-admin" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  test("does not block demo restaurant admins", async () => {
    rawDb.prepare("UPDATE restaurants SET status = ? WHERE id = ?").run("demo", "resto-1");

    const res = await app.request("/services", { headers: { cookie: "session=session-admin" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });
});

describe("requireActiveSubscription", () => {
  test("blocks cancelled restaurants from gated routes", async () => {
    rawDb.prepare("UPDATE owners SET subscription_status = ? WHERE id = ?").run("cancelled", "owner-1");
    rawDb.prepare("UPDATE restaurants SET subscription_status = ? WHERE id = ?").run("cancelled", "resto-1");

    const res = await subscriptionApp.request("/calendar", { headers: { cookie: "session=session-normal" } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Abonnement inactif", subscriptionStatus: "cancelled" });
  });

  test("blocks when owner subscription is cancelled even if restaurant mirror is active", async () => {
    rawDb.prepare("UPDATE owners SET subscription_status = ? WHERE id = ?").run("cancelled", "owner-1");

    const res = await subscriptionApp.request("/calendar", { headers: { cookie: "session=session-normal" } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Abonnement inactif", subscriptionStatus: "cancelled" });
  });

  test("falls back to restaurant subscription during compatibility migration", async () => {
    rawDb.prepare("UPDATE restaurants SET owner_id = NULL, subscription_status = ? WHERE id = ?").run("cancelled", "resto-1");

    const res = await subscriptionApp.request("/calendar", { headers: { cookie: "session=session-normal" } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Abonnement inactif", subscriptionStatus: "cancelled" });
  });

  test("allows demo restaurants through gated routes", async () => {
    rawDb.prepare("UPDATE restaurants SET status = ?, subscription_status = ? WHERE id = ?").run("demo", "cancelled", "resto-1");

    const res = await subscriptionApp.request("/calendar", { headers: { cookie: "session=session-normal" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });
});
