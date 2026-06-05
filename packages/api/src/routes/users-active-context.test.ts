import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-users-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { userRoutes } = await import("./users.js");
const { forbiddenShareResponseFields } = await import("../test/shared-worker-privacy-fields.js");

const app = new Hono();
app.route("/users", userRoutes);

const FORBIDDEN_SHARED_ROSTER_FIELDS = forbiddenShareResponseFields
  .filter((field: string) => !["email", "phone", "subRoles", "contractHours"].includes(field));

function expectSharedRosterPrivacy(row: Record<string, unknown>) {
  for (const field of FORBIDDEN_SHARED_ROSTER_FIELDS) {
    expect(row).not.toHaveProperty(field);
  }
  expect(row.email).toBe("");
  expect(row.phone).toBe("");
}

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS contract_templates;
    DROP TABLE IF EXISTS worker_availability;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS worker_preferred_schedule;
    DROP TABLE IF EXISTS services;
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
      address TEXT,
      siret TEXT,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'demo',
      subscription_status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      default_contract_hours INTEGER NOT NULL DEFAULT 39,
      kitchen_color TEXT NOT NULL DEFAULT 'amber',
      floor_color TEXT NOT NULL DEFAULT 'sky',
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
      contract_end_date TEXT,
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      inactive_from TEXT,
      inactive_until TEXT,
      hcr_level TEXT,
      hourly_rate INTEGER,
      rate_effective_from TEXT,
      permissions TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      user_notice_version TEXT,
      user_notice_accepted_at TEXT,
      user_notice_ip_address TEXT,
      user_notice_user_agent TEXT,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0
      ,
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

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data TEXT NOT NULL DEFAULT '',
      storage_provider TEXT,
      storage_key TEXT,
      storage_status TEXT NOT NULL DEFAULT 'ready',
      uploaded_by TEXT NOT NULL,
      requirement_key TEXT,
      issued_at TEXT,
      expires_at TEXT,
      signed_at TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE contract_templates (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      body_html TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE worker_availability (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      midi INTEGER NOT NULL DEFAULT 0,
      soir INTEGER NOT NULL DEFAULT 0,
      midi_start TEXT,
      midi_end TEXT,
      soir_start TEXT,
      soir_end TEXT,
      continuous INTEGER NOT NULL DEFAULT 0,
      zones TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE worker_restrictions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT,
      end_time TEXT,
      reason TEXT,
      effective_from TEXT,
      effective_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE worker_preferred_schedule (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      midi INTEGER NOT NULL DEFAULT 0,
      soir INTEGER NOT NULL DEFAULT 0,
      zones TEXT NOT NULL DEFAULT '{}'
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
  `);
}

function insertUser(input: {
  id: string;
  name: string;
  email: string;
  role: string;
  restaurantId: string;
  active?: number;
  managerNotes?: string | null;
}) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, phone, role, restaurant_id, active, permissions,
      must_change_password, priority, sub_roles, manager_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.email,
    `+336${input.id.length}`,
    input.role,
    input.restaurantId,
    input.active ?? 1,
    null,
    0,
    1,
    '["Service"]',
    input.managerNotes ?? null,
  );
}

function seedAcceptedShareToActiveRestaurant() {
  rawDb.prepare("INSERT OR IGNORE INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-a1", "member");
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run("a2", "worker-a1", 2, JSON.stringify(["Renfort"]), 24, 35);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
  `).run("share-a1-a2", "owner-a", "a1", "a2", "worker-a1", "floor", "admin-a", "2026-05-01T10:00:00.000Z");
}

function seedLimitedManagerInActiveRestaurant() {
  insertUser({ id: "manager-a2", name: "Manager A2", email: "manager-a2@example.com", role: "manager", restaurantId: "a2" });
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "manager-a2", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "manager-a2", "manager", JSON.stringify({
      TEAM_VIEW: true,
      HR_DATA_VIEW: false,
      PAYROLL_VIEW: false,
      MEDICAL_DOC_VIEW: false,
      MANAGER_NOTES_EDIT: false,
    }), 1);
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-manager-a2", "manager-a2", "a2", new Date(Date.now() + 60_000).toISOString());
}

async function expectSharedWorkerHiddenFromSchedulingRoster() {
  const res = await app.request("/users/scheduling-roster", {
    headers: { cookie: "session=session-a" },
  });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.map((row: any) => row.id).sort()).toEqual(["worker-a2", "worker-shared"]);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo");
  rawDb.prepare("UPDATE restaurants SET kitchen_color = ?, floor_color = ? WHERE id = ?")
    .run("rose", "teal", "a1");
  rawDb.prepare("UPDATE restaurants SET kitchen_color = ?, floor_color = ? WHERE id = ?")
    .run("amber", "sky", "a2");

  insertUser({ id: "admin-a", name: "Admin A", email: "admin@example.com", role: "admin", restaurantId: "a1" });
  insertUser({ id: "worker-a1", name: "Worker A1", email: "a1@example.com", role: "floor", restaurantId: "a1", managerNotes: "A1 note" });
  insertUser({ id: "worker-a2", name: "Worker A2", email: "a2@example.com", role: "floor", restaurantId: "a2", managerNotes: "A2 note" });
  insertUser({ id: "worker-shared", name: "Worker Shared", email: "shared@example.com", role: "floor", restaurantId: "a1", managerNotes: "Shared note" });

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "worker-a1", "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-a2", "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "worker-shared", "floor", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);

  rawDb.prepare(`
    INSERT INTO documents (id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("doc-a1", "worker-a1", "a1", "A1", "contract", "a1.pdf", "application/pdf", 1, "admin-a");
  rawDb.prepare(`
    INSERT INTO documents (id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("doc-a2", "worker-a2", "a2", "A2", "contract", "a2.pdf", "application/pdf", 1, "admin-a");
  rawDb.prepare(`
    INSERT INTO documents (id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("doc-shared", "worker-shared", "a2", "Shared", "contract", "shared.pdf", "application/pdf", 1, "admin-a");
  rawDb.prepare(`
    INSERT INTO documents (
      id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by,
      requirement_key, reviewed_at, reviewed_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "doc-shared-a1-id",
    "worker-shared",
    "a1",
    "Shared A1 ID",
    "id",
    "shared-a1-id.pdf",
    "application/pdf",
    1,
    "admin-a",
    "id_card",
    "2026-05-01T00:00:00.000Z",
    "admin-a",
  );

  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("avail-a1", "worker-a1", "a1", 1, 1, 0, "{}");
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("avail-a2", "worker-a2", "a2", 2, 0, 1, "{}");
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, zones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("avail-shared", "worker-shared", "a2", 3, 1, 1, "{}");
});

describe("users read routes active restaurant context", () => {
  test("GET /users lists active restaurant members instead of legacy users.restaurant_id", async () => {
    const res = await app.request("/users", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id).sort()).toEqual(["admin-a", "worker-a2", "worker-shared"]);
    expect(body.data.find((row: any) => row.id === "worker-a2").managerNotes).toBe("A2 note");
    expect(body.data.find((row: any) => row.id === "worker-shared").managerNotes).toBe("Shared note");
  });

  test("GET /users/scheduling-roster includes accepted shared workers without HR fields", async () => {
    seedAcceptedShareToActiveRestaurant();

    const res = await app.request("/users/scheduling-roster", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id).sort()).toEqual(["worker-a1", "worker-a2", "worker-shared"]);
    const shared = body.data.find((row: any) => row.id === "worker-a1");
    expect(shared).toMatchObject({
      id: "worker-a1",
      role: "floor",
      restaurantId: "a2",
      sharedFromRestaurantId: "a1",
      subRoles: ["Renfort"],
      contractHours: 24,
      email: "",
      phone: "",
    });
    expectSharedRosterPrivacy(shared);
  });

  test("GET /users/scheduling-roster returns source restaurant colors and owner-wide weekly hours", async () => {
    seedAcceptedShareToActiveRestaurant();
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("svc-a1", "worker-a1", "a1", "2026-05-18", "09:00", "15:00", "floor", "scheduled");
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("svc-a2", "worker-a1", "a2", "2026-05-19", "18:00", "22:00", "floor", "scheduled");
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("svc-cancelled", "worker-a1", "a1", "2026-05-20", "09:00", "19:00", "floor", "cancelled");
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("svc-outside", "worker-a1", "a1", "2026-05-25", "09:00", "17:00", "floor", "scheduled");

    const res = await app.request("/users/scheduling-roster?from=2026-05-18&to=2026-05-24", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shared = body.data.find((row: any) => row.id === "worker-a1");
    const local = body.data.find((row: any) => row.id === "worker-a2");
    expect(shared).toMatchObject({
      primaryRestaurantId: "a1",
      primaryRestaurantName: "Alpha",
      primaryKitchenColor: "rose",
      primaryFloorColor: "teal",
      weeklyHours: 10,
    });
    expect(local).toMatchObject({
      primaryRestaurantId: "a2",
      primaryRestaurantName: "Beta",
      primaryKitchenColor: "amber",
      primaryFloorColor: "sky",
    });
  });

  test("GET /users/scheduling-roster gives target managers scheduling identity only for shared workers", async () => {
    seedAcceptedShareToActiveRestaurant();
    seedLimitedManagerInActiveRestaurant();

    const res = await app.request("/users/scheduling-roster", {
      headers: { cookie: "session=session-manager-a2" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const shared = body.data.find((row: any) => row.id === "worker-a1");
    expect(shared).toMatchObject({
      id: "worker-a1",
      name: "Worker A1",
      role: "floor",
      restaurantId: "a2",
      sharedFromRestaurantId: "a1",
      email: "",
      phone: "",
    });
    expectSharedRosterPrivacy(shared);
  });

  test("GET /users/scheduling-roster ignores stale accepted shares with revoked timestamps", async () => {
    seedAcceptedShareToActiveRestaurant();
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-a1-a2");

    await expectSharedWorkerHiddenFromSchedulingRoster();
  });

  for (const scenario of [
    {
      name: "source membership is inactive",
      mutate: () => rawDb.prepare(`
        UPDATE restaurant_memberships SET active = 0 WHERE restaurant_id = ? AND user_id = ?
      `).run("a1", "worker-a1"),
    },
    {
      name: "source role no longer matches the accepted share",
      mutate: () => rawDb.prepare(`
        UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?
      `).run("manager", "a1", "worker-a1"),
    },
    {
      name: "worker leaves the owner account",
      mutate: () => rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
        .run("owner-a", "worker-a1"),
    },
    {
      name: "worker account is inactive",
      mutate: () => rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?")
        .run("worker-a1"),
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
      name: "target restaurant profile is missing",
      mutate: () => rawDb.prepare("DELETE FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
        .run("a2", "worker-a1"),
    },
  ]) {
    test(`GET /users/scheduling-roster ignores stale accepted shares when ${scenario.name}`, async () => {
      seedAcceptedShareToActiveRestaurant();
      scenario.mutate();

      await expectSharedWorkerHiddenFromSchedulingRoster();
    });
  }

  test("GET /users/scheduling-roster treats workers with direct target membership as local, not shared", async () => {
    seedAcceptedShareToActiveRestaurant();
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a2", "worker-a1", "floor", null, 1);

    const res = await app.request("/users/scheduling-roster", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const worker = body.data.find((row: any) => row.id === "worker-a1");
    expect(body.data.filter((row: any) => row.id === "worker-a1")).toHaveLength(1);
    expect(worker).toMatchObject({
      id: "worker-a1",
      restaurantId: "a2",
    });
    expect(worker.sharedFromRestaurantId).toBeUndefined();
  });

  test("GET /users/:id cannot read a user from the legacy restaurant when active context is different", async () => {
    const legacy = await app.request("/users/worker-a1", {
      headers: { cookie: "session=session-a" },
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/users/worker-a2", {
      headers: { cookie: "session=session-a" },
    });
    expect(active.status).toBe(200);
    expect((await active.json()).data.id).toBe("worker-a2");

    const shared = await app.request("/users/worker-shared", {
      headers: { cookie: "session=session-a" },
    });
    expect(shared.status).toBe(200);
    expect((await shared.json()).data.id).toBe("worker-shared");
  });

  test("GET and PATCH /users/:id reject accepted shared workers without direct target membership", async () => {
    seedAcceptedShareToActiveRestaurant();

    const roster = await app.request("/users/scheduling-roster", {
      headers: { cookie: "session=session-a" },
    });
    expect(roster.status).toBe(200);
    expect((await roster.json()).data.map((row: any) => row.id)).toContain("worker-a1");

    const detail = await app.request("/users/worker-a1", {
      headers: { cookie: "session=session-a" },
    });
    expect(detail.status).toBe(404);

    const update = await app.request("/users/worker-a1", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ priority: 4 }),
    });
    expect(update.status).toBe(404);
  });

  test("employee dossier actions reject accepted shared workers without direct target membership", async () => {
    seedAcceptedShareToActiveRestaurant();

    const checklist = await app.request("/users/worker-a1/checklist", {
      headers: { cookie: "session=session-a" },
    });
    expect(checklist.status).toBe(404);

    const contract = await app.request("/users/worker-a1/generate-contract", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ kind: "CDI" }),
    });
    expect(contract.status).toBe(404);

    const invite = await app.request("/users/worker-a1/invite", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(invite.status).toBe(404);
  });

  test("restaurant dossier summary excludes accepted shared workers without direct target membership", async () => {
    seedAcceptedShareToActiveRestaurant();
    rawDb.prepare(`
      INSERT INTO documents (
        id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by,
        requirement_key, expires_at, reviewed_at, reviewed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "doc-a1-shared-a2-expiring",
      "worker-a1",
      "a2",
      "A1 shared target ID",
      "identity",
      "a1-shared-target-id.pdf",
      "application/pdf",
      1,
      "admin-a",
      "id_card",
      "2026-05-01",
      "2026-04-01T00:00:00.000Z",
      "admin-a",
    );

    const status = await app.request("/users/dossier-status", {
      headers: { cookie: "session=session-a" },
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.data.workers.map((row: any) => row.workerId).sort()).toEqual(["worker-a2", "worker-shared"]);

    const expiring = await app.request("/users/checklist/expiring", {
      headers: { cookie: "session=session-a" },
    });
    expect(expiring.status).toBe(200);
    const expiringBody = await expiring.json();
    expect(expiringBody.data.map((row: any) => row.workerId)).not.toContain("worker-a1");
  });

  test("POST /users creates workers in the active restaurant and bumps only active cache", async () => {
    const res = await app.request("/users", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "New",
        lastName: "Worker",
        email: "new-worker@example.com",
        phone: "+33699999999",
        role: "floor",
        password: "secret1",
        subRoles: ["Service"],
      }),
    });

    expect(res.status).toBe(201);
    const created = rawDb.query("SELECT email, restaurant_id, contract_hours AS contractHours FROM users WHERE email = ?").get("new-worker@example.com");
    expect(created).toEqual({ email: "new-worker@example.com", restaurant_id: "a2", contractHours: 39 });
    const membership = rawDb.query(`
      SELECT restaurant_id AS restaurantId, role, active
      FROM restaurant_memberships
      WHERE user_id = (SELECT id FROM users WHERE email = ?)
    `).get("new-worker@example.com");
    expect(membership).toEqual({ restaurantId: "a2", role: "floor", active: 1 });
    const profile = rawDb.query(`
      SELECT restaurant_id AS restaurantId, sub_roles AS subRoles, contract_hours AS contractHours
      FROM worker_restaurant_profiles
      WHERE user_id = (SELECT id FROM users WHERE email = ?)
    `).get("new-worker@example.com");
    expect(profile).toEqual({ restaurantId: "a2", subRoles: JSON.stringify(["Service"]), contractHours: 39 });
    const list = await app.request("/users", {
      headers: { cookie: "session=session-a" },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.map((row: any) => row.email)).toContain("new-worker@example.com");
    const restaurants = rawDb.query("SELECT id, cache_version FROM restaurants ORDER BY id").all();
    expect(restaurants).toEqual([
      { id: "a1", cache_version: 0 },
      { id: "a2", cache_version: 1 },
    ]);
  });

  test("PATCH /users/:id cannot update a legacy restaurant user", async () => {
    const legacy = await app.request("/users/worker-a1", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ priority: 5 }),
    });
    expect(legacy.status).toBe(404);

    const active = await app.request("/users/worker-a2", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ priority: 7 }),
    });
    expect(active.status).toBe(200);

    const shared = await app.request("/users/worker-shared", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ priority: 9 }),
    });
    expect(shared.status).toBe(200);

    const rows = rawDb.query("SELECT id, priority FROM users WHERE id IN ('worker-a1', 'worker-a2', 'worker-shared') ORDER BY id").all();
    expect(rows).toEqual([
      { id: "worker-a1", priority: 1 },
      { id: "worker-a2", priority: 7 },
      { id: "worker-shared", priority: 9 },
    ]);
  });

  test("document and availability routes are scoped to the active restaurant", async () => {
    const legacyDocs = await app.request("/users/worker-a1/documents", {
      headers: { cookie: "session=session-a" },
    });
    expect(legacyDocs.status).toBe(404);

    const activeDocs = await app.request("/users/worker-a2/documents", {
      headers: { cookie: "session=session-a" },
    });
    expect(activeDocs.status).toBe(200);
    expect((await activeDocs.json()).data.map((row: any) => row.id)).toEqual(["doc-a2"]);

    const legacyAvailability = await app.request("/users/worker-a1/availability", {
      headers: { cookie: "session=session-a" },
    });
    expect(legacyAvailability.status).toBe(404);

    const activeAvailability = await app.request("/users/worker-a2/availability", {
      headers: { cookie: "session=session-a" },
    });
    expect(activeAvailability.status).toBe(200);
    expect((await activeAvailability.json()).data.map((row: any) => row.dayOfWeek)).toEqual([2]);
  });

  test("document and availability routes accept active membership even when legacy restaurant_id differs", async () => {
    const docs = await app.request("/users/worker-shared/documents", {
      headers: { cookie: "session=session-a" },
    });
    expect(docs.status).toBe(200);
    expect((await docs.json()).data.map((row: any) => row.id)).toEqual(["doc-shared"]);

    const availability = await app.request("/users/worker-shared/availability", {
      headers: { cookie: "session=session-a" },
    });
    expect(availability.status).toBe(200);
    expect((await availability.json()).data.map((row: any) => row.dayOfWeek)).toEqual([3]);
  });

  test("medical documents are not shared through worker-share authorization by default", async () => {
    seedAcceptedShareToActiveRestaurant();
    rawDb.prepare(`
      INSERT INTO documents (id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("doc-a1-medical", "worker-a1", "a1", "A1 medical", "medical", "a1-medical.pdf", "application/pdf", 1, "admin-a");

    const docs = await app.request("/users/worker-a1/documents", {
      headers: { cookie: "session=session-a" },
    });
    expect(docs.status).toBe(404);

    const download = await app.request("/users/worker-a1/documents/doc-a1-medical", {
      headers: { cookie: "session=session-a" },
    });
    expect(download.status).toBe(404);
  });

  test("document upload and review mutations reject accepted shared workers without direct target membership", async () => {
    seedAcceptedShareToActiveRestaurant();
    rawDb.prepare(`
      INSERT INTO documents (id, user_id, restaurant_id, name, type, filename, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("doc-a1-target", "worker-a1", "a2", "A1 target", "contract", "a1-target.pdf", "application/pdf", 1, "admin-a");

    const presign = await app.request("/users/worker-a1/documents/presign", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ filename: "id.pdf", mimeType: "application/pdf", size: 128 }),
    });
    expect(presign.status).toBe(404);

    const upload = await app.request("/users/worker-a1/documents", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({
        name: "ID",
        type: "identity",
        filename: "id.pdf",
        mimeType: "application/pdf",
        size: 128,
        storageKey: "pending/doc.pdf",
      }),
    });
    expect(upload.status).toBe(404);

    const patch = await app.request("/users/worker-a1/documents/doc-a1-target", {
      method: "PATCH",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ signedAt: "2026-05-01" }),
    });
    expect(patch.status).toBe(404);

    const confirm = await app.request("/users/worker-a1/documents/doc-a1-target/confirm", {
      method: "POST",
      headers: { cookie: "session=session-a" },
    });
    expect(confirm.status).toBe(404);

    const remove = await app.request("/users/worker-a1/documents/doc-a1-target", {
      method: "DELETE",
      headers: { cookie: "session=session-a" },
    });
    expect(remove.status).toBe(404);
  });

  test("checklist ignores documents from the worker's legacy restaurant", async () => {
    const checklist = await app.request("/users/worker-shared/checklist", {
      headers: { cookie: "session=session-a" },
    });

    expect(checklist.status).toBe(200);
    const body = await checklist.json();
    const idCard = body.data.items.find((item: any) => item.key === "id_card");
    expect(idCard.status).toBe("missing");
  });

  test("contract generation accepts active membership even when legacy restaurant_id differs", async () => {
    const res = await app.request("/users/worker-shared/generate-contract", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ kind: "CDI" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tokens["worker.name"]).toBe("Worker Shared");
    expect(body.data.tokens["restaurant.name"]).toBe("Beta");
    expect(body.data.html).toContain("Worker Shared");
  });

  test("DPAE export accepts active membership even when legacy restaurant_id differs", async () => {
    const res = await app.request("/users/dpae/export", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ workerIds: ["worker-shared"] }),
    });

    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("Worker Shared");
    expect(csv).toContain("Beta");
  });
});
