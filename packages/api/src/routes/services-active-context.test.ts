import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-services-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { serviceRoutes } = await import("./services.js");

const app = new Hono();
app.route("/services", serviceRoutes);

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_A1_ID = "00000000-0000-4000-8000-000000000101";
const WORKER_A2_ID = "00000000-0000-4000-8000-000000000202";
const MOVE_SERVICE_ID = "00000000-0000-4000-8000-00000000a2f1";

const staleAcceptedShareScenarios = [
  {
    name: "worker consent is missing",
    mutate: () => rawDb.prepare("UPDATE worker_share_authorizations SET worker_consented_at = NULL WHERE id = ?")
      .run(`share-${WORKER_A1_ID}-a2`),
  },
  {
    name: "source membership is inactive",
    mutate: () => rawDb.prepare("UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?")
      .run("a1", WORKER_A1_ID),
  },
  {
    name: "source role no longer matches",
    mutate: () => rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("manager", "a1", WORKER_A1_ID),
  },
  {
    name: "worker leaves the owner account",
    mutate: () => rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-a", WORKER_A1_ID),
  },
  {
    name: "worker account is inactive",
    mutate: () => rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?")
      .run(WORKER_A1_ID),
  },
  {
    name: "source restaurant leaves the owner",
    mutate: () => rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-b", "a1"),
  },
  {
    name: "target restaurant leaves the owner",
    mutate: () => rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?")
      .run("owner-b", "a2"),
  },
  {
    name: "target worker profile is missing",
    mutate: () => rawDb.prepare("DELETE FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
      .run("a2", WORKER_A1_ID),
  },
];

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS open_shifts;
    DROP TABLE IF EXISTS replacement_requests;
    DROP TABLE IF EXISTS time_clocks;
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      active_restaurant_id TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      source TEXT NOT NULL DEFAULT 'manual',
      filled_as TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE published_weeks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      week_date TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE time_clocks (
      id TEXT PRIMARY KEY,
      service_id TEXT
    );

    CREATE TABLE replacement_requests (
      id TEXT PRIMARY KEY,
      requester_service_id TEXT NOT NULL
    );

    CREATE TABLE open_shifts (
      id TEXT PRIMARY KEY,
      service_id TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      source TEXT NOT NULL,
      changes TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  insertUser(ADMIN_ID, "Admin A", "admin@example.com", "admin", "a1");
  insertUser(WORKER_A1_ID, "Worker A1", "worker-a1@example.com", "floor", "a1");
  insertUser(WORKER_A2_ID, "Worker A2", "worker-a2@example.com", "floor", "a2");

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", ADMIN_ID, "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", ADMIN_ID, "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", ADMIN_ID, "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", WORKER_A1_ID, "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", WORKER_A2_ID, "floor", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", ADMIN_ID, "a2", future);

  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-a1", "a1", WORKER_A1_ID, "2026-05-12", "09:00", "12:00", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("service-a2", "a2", WORKER_A2_ID, "2026-05-12", "14:00", "18:00", "floor", "scheduled");
});

describe("services routes active restaurant context", () => {
  test("GET /services reads services from the active restaurant", async () => {
    const res = await app.request("/services?from=2026-05-12&to=2026-05-12", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((service: any) => service.id)).toEqual(["service-a2"]);
    expect(body.data[0].workerName).toBe("Worker A2");
  });

  test("POST /services cannot schedule a worker from the legacy restaurant into active restaurant", async () => {
    const res = await app.request("/services", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_A1_ID,
        date: "2026-05-13",
        startTime: "12:00",
        endTime: "15:00",
        role: "floor",
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
    expect(rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = 'a2'").get()).toEqual({ count: 1 });
  });

  test("POST /services writes new services under the active restaurant", async () => {
    const res = await app.request("/services", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_A2_ID,
        date: "2026-05-13",
        startTime: "12:00",
        endTime: "15:00",
        role: "floor",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.restaurantId).toBe("a2");
    expect(rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = 'a1'").get()).toEqual({ count: 1 });
    expect(rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = 'a2'").get()).toEqual({ count: 2 });
  });

  test("POST /services can schedule an accepted shared worker into the target restaurant", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");

    const res = await app.request("/services", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_A1_ID,
        date: "2026-05-13",
        startTime: "12:00",
        endTime: "15:00",
        role: "floor",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ restaurantId: "a2", workerId: WORKER_A1_ID });
  });

  test("POST /services rejects accepted shared worker for a different service role", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");

    const res = await app.request("/services", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_A1_ID,
        date: "2026-05-13",
        startTime: "12:00",
        endTime: "15:00",
        role: "kitchen",
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
  });

  test("PATCH /services rejects shared worker reassignment when the share role does not match", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");

    const res = await app.request("/services/service-a2", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_A1_ID,
        role: "kitchen",
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
    expect(rawDb.query("SELECT worker_id AS workerId, role FROM services WHERE id = 'service-a2'").get()).toEqual({
      workerId: WORKER_A2_ID,
      role: "floor",
    });
  });

  test("PATCH /services rejects changing an accepted shared worker service to a different role", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");
    rawDb.prepare(`
      INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("shared-floor-service", "a2", WORKER_A1_ID, "2026-05-13", "12:00", "15:00", "floor", "scheduled");

    const res = await app.request("/services/shared-floor-service", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ role: "kitchen" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
    expect(rawDb.query("SELECT worker_id AS workerId, role FROM services WHERE id = 'shared-floor-service'").get()).toEqual({
      workerId: WORKER_A1_ID,
      role: "floor",
    });
  });

  test("POST /services/move rejects shared worker reassignment when the existing service role does not match", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");
    const kitchenServiceId = "00000000-0000-4000-8000-00000000a2c1";
    rawDb.prepare(`
      INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(kitchenServiceId, "a2", WORKER_A2_ID, "2026-05-13", "08:00", "10:00", "kitchen", "scheduled");

    const res = await app.request("/services/move", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: kitchenServiceId,
        newWorkerId: WORKER_A1_ID,
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé non trouvé" });
    expect(rawDb.query("SELECT worker_id AS workerId FROM services WHERE id = ?").get(kitchenServiceId)).toEqual({
      workerId: WORKER_A2_ID,
    });
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`PATCH /services rejects stale accepted share reassignment when ${scenario.name}`, async () => {
      seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");
      scenario.mutate();

      await expectSharedWorkerServicePatchRejected();
    });
  }

  for (const scenario of staleAcceptedShareScenarios) {
    test(`POST /services/move rejects stale accepted share reassignment when ${scenario.name}`, async () => {
      seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");
      scenario.mutate();

      await expectSharedWorkerServiceMoveRejected();
    });
  }

  test("POST /services rejects stale accepted share when revoked timestamp exists", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", `share-${WORKER_A1_ID}-a2`);

    await expectSharedWorkerServiceCreateRejected();
  });

  for (const scenario of staleAcceptedShareScenarios) {
    test(`POST /services rejects stale accepted share when ${scenario.name}`, async () => {
      seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");
      scenario.mutate();

      await expectSharedWorkerServiceCreateRejected();
    });
  }

  test("POST /services blocks accepted shared worker overlaps in the source restaurant", async () => {
    seedAcceptedShare(WORKER_A1_ID, "a1", "a2", "floor");

    const res = await app.request("/services", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_A1_ID,
        date: "2026-05-12",
        startTime: "10:00",
        endTime: "11:00",
        role: "floor",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Worker A1 is already working this service (09:00–12:00)" });
  });
});

async function expectSharedWorkerServiceCreateRejected() {
  const res = await app.request("/services", {
    method: "POST",
    headers: { cookie: "session=session-a", "content-type": "application/json" },
    body: JSON.stringify({
      workerId: WORKER_A1_ID,
      date: "2026-05-13",
      startTime: "12:00",
      endTime: "15:00",
      role: "floor",
    }),
  });

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Employé non trouvé" });
  expect(rawDb.query(`
    SELECT COUNT(*) AS count
    FROM services
    WHERE restaurant_id = 'a2'
      AND worker_id = ?
      AND date = '2026-05-13'
  `).get(WORKER_A1_ID)).toEqual({ count: 0 });
}

async function expectSharedWorkerServicePatchRejected() {
  const res = await app.request("/services/service-a2", {
    method: "PATCH",
    headers: { cookie: "session=session-a", "content-type": "application/json" },
    body: JSON.stringify({ workerId: WORKER_A1_ID }),
  });

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Employé non trouvé" });
  expect(rawDb.query("SELECT worker_id AS workerId FROM services WHERE id = 'service-a2'").get()).toEqual({
    workerId: WORKER_A2_ID,
  });
}

async function expectSharedWorkerServiceMoveRejected() {
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(MOVE_SERVICE_ID, "a2", WORKER_A2_ID, "2026-05-13", "12:00", "15:00", "floor", "scheduled");

  const res = await app.request("/services/move", {
    method: "POST",
    headers: { cookie: "session=session-a", "content-type": "application/json" },
    body: JSON.stringify({
      serviceId: MOVE_SERVICE_ID,
      newWorkerId: WORKER_A1_ID,
    }),
  });

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Employé non trouvé" });
  expect(rawDb.query("SELECT worker_id AS workerId FROM services WHERE id = ?").get(MOVE_SERVICE_ID)).toEqual({
    workerId: WORKER_A2_ID,
  });
}

function seedAcceptedShare(workerId: string, sourceRestaurantId: string, targetRestaurantId: string, role: "kitchen" | "floor") {
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", workerId, "member");
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_type, contract_hours, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(targetRestaurantId, workerId, 1, "[]", "CDI", 35, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `share-${workerId}-${targetRestaurantId}`,
    "owner-a",
    sourceRestaurantId,
    targetRestaurantId,
    workerId,
    role,
    "accepted",
    ADMIN_ID,
    "2026-05-01T00:00:00.000Z",
  );
}
