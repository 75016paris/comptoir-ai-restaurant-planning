import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-schedule-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { scheduleRoutes } = await import("./schedule.js");

const app = new Hono();
app.route("/schedule", scheduleRoutes);

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS time_clocks;
    DROP TABLE IF EXISTS holiday_requests;
    DROP TABLE IF EXISTS published_weeks;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS sessions;
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
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'demo',
      subscription_status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      tap_in_out_mode TEXT,
      tap_in_counts_as_hours INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER,
      phone TEXT,
      overtime_willing INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE worker_restaurant_profiles (
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER,
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
    );

    CREATE TABLE published_weeks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      week_date TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE time_clocks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      service_id TEXT,
      date TEXT NOT NULL,
      tap_in TEXT NOT NULL,
      tap_out TEXT
    );

    CREATE TABLE holiday_requests (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL,
      medical INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function insertUser(id: string, name: string, email: string, role: string, restaurantId: string) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, role, restaurantId, 1, null, 0);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo");

  insertUser("admin-a", "Admin A", "admin@example.com", "admin", "a1");
  insertUser("worker-a1", "Worker A1", "worker-a1@example.com", "floor", "a1");
  insertUser("worker-a2", "Worker A2", "worker-a2@example.com", "floor", "a2");
  insertUser("worker-shared", "Worker Shared", "worker-shared@example.com", "floor", "a1");
  insertUser("worker-accepted-share", "Worker Accepted Share", "accepted-share@example.com", "floor", "a1");

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-accepted-share", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-a2", "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-shared", "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "worker-accepted-share", "floor", null, 1);

  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, multi_restaurant_willing)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("a2", "worker-accepted-share", 1, "[]", 24, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "share-worker-accepted",
    "owner-a",
    "a1",
    "a2",
    "worker-accepted-share",
    "floor",
    "accepted",
    "admin-a",
    "2026-05-01T10:00:00.000Z",
    null,
  );

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-a1", "a1", "worker-a1", "2026-05-12", "09:00", "12:00", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-a2", "a2", "worker-a2", "2026-05-12", "14:00", "18:00", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-shared-a2", "a2", "worker-shared", "2026-05-13", "09:00", "13:30", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-accepted-share-a2", "a2", "worker-accepted-share", "2026-05-13", "14:00", "18:00", "floor", "scheduled");

  rawDb.prepare("INSERT INTO published_weeks (id, restaurant_id, week_date, published_at) VALUES (?, ?, ?, ?)")
    .run("published-a2", "a2", "2026-05-11", "2026-05-10T10:00:00.000Z");
});

describe("schedule routes active restaurant context", () => {
  test("GET /schedule/who-works reads the active restaurant instead of legacy users.restaurant_id", async () => {
    const res = await app.request("/schedule/who-works?date=2026-05-12", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{
      workerId: "worker-a2",
      workerName: "Worker A2",
      role: "floor",
      startTime: "14:00",
      endTime: "18:00",
      status: "scheduled",
    }]);
  });

  test("GET /schedule/week/published reads active restaurant publication state", async () => {
    const res = await app.request("/schedule/week/published?date=2026-05-12", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        published: true,
        publishedAt: "2026-05-10T10:00:00.000Z",
      },
    });
  });

  test("GET /schedule/hours accepts active membership even when legacy users.restaurant_id differs", async () => {
    const res = await app.request("/schedule/hours?workerId=worker-shared&from=2026-05-11&to=2026-05-17", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      workerId: "worker-shared",
      workerName: "Worker Shared",
      totalHours: 4.5,
      serviceCount: 1,
    });
    expect(body.data.services.map((service: { id: string }) => service.id)).toEqual(["service-shared-a2"]);
  });

  test("GET /schedule/hours accepts a live accepted share without target membership", async () => {
    const res = await app.request("/schedule/hours?workerId=worker-accepted-share&from=2026-05-11&to=2026-05-17", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      workerId: "worker-accepted-share",
      workerName: "Worker Accepted Share",
      totalHours: 4,
      serviceCount: 1,
    });
    expect(body.data.services.map((service: { id: string }) => service.id)).toEqual(["service-accepted-share-a2"]);
  });

  test("GET /schedule/hours rejects a stale accepted share after revocation", async () => {
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-10T10:00:00.000Z", "share-worker-accepted");

    const res = await app.request("/schedule/hours?workerId=worker-accepted-share&from=2026-05-11&to=2026-05-17", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Worker not found" });
  });

  test("GET /schedule/who-works shows live accepted shares and hides them after revocation", async () => {
    rawDb.prepare(`
      INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("service-accepted-share-wrong-role", "a2", "worker-accepted-share", "2026-05-13", "19:00", "21:00", "kitchen", "scheduled");

    const live = await app.request("/schedule/who-works?date=2026-05-13", {
      headers: { cookie: "session=session-a" },
    });

    expect(live.status).toBe(200);
    const liveBody = await live.json();
    expect(liveBody.data.map((service: { workerId: string }) => service.workerId)).toEqual([
      "worker-shared",
      "worker-accepted-share",
    ]);

    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-10T10:00:00.000Z", "share-worker-accepted");

    const stale = await app.request("/schedule/who-works?date=2026-05-13", {
      headers: { cookie: "session=session-a" },
    });

    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    expect(staleBody.data.map((service: { workerId: string }) => service.workerId)).toEqual(["worker-shared"]);
  });

  test("GET /schedule/monthly-recap includes accepted shares with target profile contract hours", async () => {
    rawDb.prepare("UPDATE users SET role = ? WHERE id = ?").run("kitchen", "worker-accepted-share");
    rawDb.prepare(`
      INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("service-accepted-share-monthly-wrong-role", "a2", "worker-accepted-share", "2026-05-14", "10:00", "13:00", "kitchen", "scheduled");

    const res = await app.request("/schedule/monthly-recap?month=2026-05", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const sharedWorker = body.data.workers.find((worker: { workerId: string }) => worker.workerId === "worker-accepted-share");
    expect(sharedWorker).toMatchObject({
      workerId: "worker-accepted-share",
      workerName: "Worker Accepted Share",
      workerRole: "floor",
      contractHours: 24,
      serviceCount: 1,
      totalHours: 4,
      analytics: [{
        restaurantId: "a2",
        restaurantName: "Beta",
        serviceCount: 1,
        actualServiceCount: 1,
        totalHours: 4,
        actualHours: 4,
      }],
    });
  });

  test("GET /schedule/monthly-recap shows shared target hours in the source restaurant with analytics", async () => {
    rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
      .run("session-source", "admin-a", "a1", new Date(Date.now() + 60_000).toISOString());

    const res = await app.request("/schedule/monthly-recap?month=2026-05", {
      headers: { cookie: "session=session-source" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const sharedWorker = body.data.workers.find((worker: { workerId: string }) => worker.workerId === "worker-accepted-share");
    expect(sharedWorker).toMatchObject({
      workerId: "worker-accepted-share",
      workerName: "Worker Accepted Share",
      workerRole: "floor",
      serviceCount: 1,
      totalHours: 4,
      analytics: [{
        restaurantId: "a2",
        restaurantName: "Beta",
        serviceCount: 1,
        actualServiceCount: 1,
        totalHours: 4,
        actualHours: 4,
      }],
    });
  });

  test("GET /schedule/monthly-recap hides stale accepted-share target services", async () => {
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-10T10:00:00.000Z", "share-worker-accepted");

    const res = await app.request("/schedule/monthly-recap?month=2026-05", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.workers.map((worker: { workerId: string }) => worker.workerId)).not.toContain("worker-accepted-share");
  });
});
