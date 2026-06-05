import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-replacements-active-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { replacementRoutes } = await import("./replacements.js");

const app = new Hono();
app.route("/services/replacement", replacementRoutes);

const legacyServiceUuid = "11111111-1111-4111-8111-111111111111";
const activeServiceUuid = "22222222-2222-4222-8222-222222222222";
const targetWorkerUuid = "33333333-3333-4333-8333-333333333333";
const sharedTargetUuid = "44444444-4444-4444-8444-444444444444";

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS replacement_requests;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS holiday_requests;
    DROP TABLE IF EXISTS worker_availability;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS worker_preferred_schedule;
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
      onboarding_completed_at TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      password_hash TEXT,
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
      inactive_from TEXT,
      inactive_until TEXT,
      hcr_level TEXT,
      hourly_rate INTEGER,
      rate_effective_from TEXT,
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
      status TEXT NOT NULL DEFAULT 'scheduled'
    );

    CREATE TABLE holiday_requests (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      restaurant_id TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT
    );

    CREATE TABLE worker_availability (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      restaurant_id TEXT,
      day_of_week INTEGER,
      midi INTEGER,
      soir INTEGER,
      zones TEXT DEFAULT '{}'
    );

    CREATE TABLE worker_restrictions (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      restaurant_id TEXT,
      day_of_week INTEGER,
      start_time TEXT,
      end_time TEXT,
      reason TEXT,
      effective_from TEXT,
      effective_until TEXT
    );

    CREATE TABLE worker_preferred_schedule (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      restaurant_id TEXT,
      day_of_week INTEGER,
      midi INTEGER,
      soir INTEGER,
      zones TEXT DEFAULT '{}'
    );

    CREATE TABLE replacement_requests (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      requester_service_id TEXT NOT NULL,
      target_id TEXT,
      restaurant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_admin_decision',
      message TEXT,
      responded_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      candidate_ids TEXT,
      candidate_scores TEXT,
      admin_notified_at TEXT,
      worker_notified_at TEXT,
      escalation_count INTEGER NOT NULL DEFAULT 0,
      rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
      medical INTEGER NOT NULL DEFAULT 0,
      itt_reminder_sent_at TEXT
    );

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      replacement_request_id TEXT
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

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "demo");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "demo");

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1, null, 0);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-a", "Worker A", "worker-a@example.com", "floor", "a1", 1, null, 0);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(targetWorkerUuid, "Target A2", "target-a2@example.com", "floor", "a1", 1, null, 0);
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sharedTargetUuid, "Shared Target", "shared-target@example.com", "floor", "a1", 1, null, 0);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", sharedTargetUuid, "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "admin-a", "admin", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a2", targetWorkerUuid, "floor", null, 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run("a1", sharedTargetUuid, "floor", null, 1);

  const future = new Date(Date.now() + 60_000).toISOString();
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-a", "admin-a", "a2", future);
  rawDb.prepare("INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES (?, ?, ?, ?)")
    .run("session-target", targetWorkerUuid, "a2", future);

  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("svc-a1", "worker-a", "a1", "2026-05-20", "10:00", "14:00", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(legacyServiceUuid, "worker-a", "a1", "2026-05-22", "10:00", "14:00", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("svc-a2", "worker-a", "a2", "2026-05-21", "10:00", "14:00", "floor", "scheduled");
  rawDb.prepare(`
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(activeServiceUuid, "worker-a", "a2", "2026-05-23", "10:00", "14:00", "floor", "scheduled");

  rawDb.prepare(`
    INSERT INTO replacement_requests (
      id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, medical
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("repl-a1", "worker-a", "svc-a1", "a1", "awaiting_worker_reply", "A1", "2099-01-01T00:00:00.000Z", 0);
  rawDb.prepare(`
    INSERT INTO replacement_requests (
      id, requester_id, requester_service_id, restaurant_id, status, message, expires_at, medical
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("repl-a2", "worker-a", "svc-a2", "a2", "awaiting_worker_reply", "A2", "2099-01-01T00:00:00.000Z", 0);
  rawDb.prepare("INSERT INTO documents (id, restaurant_id, replacement_request_id) VALUES (?, ?, ?)")
    .run("doc-a1", "a1", "repl-a1");
  rawDb.prepare("INSERT INTO documents (id, restaurant_id, replacement_request_id) VALUES (?, ?, ?)")
    .run("doc-a2", "a2", "repl-a2");
});

function seedAcceptedSharedTarget() {
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run("a2", sharedTargetUuid, 1, JSON.stringify(["Renfort"]), 24, 35);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
  `).run("share-target", "owner-a", "a1", "a2", sharedTargetUuid, "floor", "admin-a", "2026-05-01T10:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("avail-shared-target-a2", sharedTargetUuid, "a2", 6, 1, 1);
}

async function expectSharedTargetRequestRejected() {
  const res = await app.request("/services/replacement/request", {
    method: "POST",
    headers: { cookie: "session=session-a", "content-type": "application/json" },
    body: JSON.stringify({ requesterServiceId: activeServiceUuid, targetId: sharedTargetUuid }),
  });

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Employé cible non trouvé" });
  const row = rawDb.query("SELECT COUNT(*) AS count FROM replacement_requests WHERE requester_service_id = ? AND target_id = ?")
    .get(activeServiceUuid, sharedTargetUuid) as { count: number };
  expect(row.count).toBe(0);
}

describe("replacement read routes active restaurant context", () => {
  test("GET /all lists active restaurant replacements instead of legacy users.restaurant_id", async () => {
    const res = await app.request("/services/replacement/all", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => ({ id: row.id, message: row.message, documentCount: row.documentCount })))
      .toEqual([{ id: "repl-a2", message: "A2", documentCount: 1 }]);
  });

  test("GET /pending lists active restaurant pending replacements only", async () => {
    const res = await app.request("/services/replacement/pending", {
      headers: { cookie: "session=session-a" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.id)).toEqual(["repl-a2"]);
  });

  test("POST /find cannot see a service from the legacy restaurant", async () => {
    const res = await app.request("/services/replacement/find", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ serviceId: "svc-a1" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service not found" });
  });

  test("POST /request cannot create from a service in the legacy restaurant", async () => {
    const res = await app.request("/services/replacement/request", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ requesterServiceId: legacyServiceUuid }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service non trouvé" });
  });

  test("POST /request accepts a target worker from active restaurant membership despite legacy restaurant_id", async () => {
    const res = await app.request("/services/replacement/request", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ requesterServiceId: activeServiceUuid, targetId: targetWorkerUuid }),
    });

    expect(res.status).toBe(201);
    const row = rawDb.query("SELECT restaurant_id, target_id FROM replacement_requests WHERE requester_service_id = ?")
      .get(activeServiceUuid) as any;
    expect(row).toEqual({ restaurant_id: "a2", target_id: targetWorkerUuid });
  });

  test("POST /request rejects a direct target who is no longer live-eligible", async () => {
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("target-request-conflict", targetWorkerUuid, "a2", "2026-05-23", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/services/replacement/request", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ requesterServiceId: activeServiceUuid, targetId: targetWorkerUuid }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Candidat non disponible pour cette demande" });
    const row = rawDb.query("SELECT COUNT(*) AS count FROM replacement_requests WHERE requester_service_id = ? AND target_id = ?")
      .get(activeServiceUuid, targetWorkerUuid) as { count: number };
    expect(row.count).toBe(0);
  });

  test("POST /request accepts an explicitly shared target worker", async () => {
    seedAcceptedSharedTarget();

    const res = await app.request("/services/replacement/request", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ requesterServiceId: activeServiceUuid, targetId: sharedTargetUuid }),
    });

    expect(res.status).toBe(201);
    const row = rawDb.query("SELECT restaurant_id, target_id FROM replacement_requests WHERE requester_service_id = ?")
      .get(activeServiceUuid) as any;
    expect(row).toEqual({ restaurant_id: "a2", target_id: sharedTargetUuid });
  });

  test("POST /request rejects explicitly shared target when share role does not match service", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("UPDATE services SET role = ? WHERE id = ?").run("kitchen", activeServiceUuid);

    const res = await app.request("/services/replacement/request", {
      method: "POST",
      headers: { cookie: "session=session-a", "content-type": "application/json" },
      body: JSON.stringify({ requesterServiceId: activeServiceUuid, targetId: sharedTargetUuid }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Employé cible non trouvé" });
  });

  test("POST /request rejects stale accepted shared target when revoked timestamp exists", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T10:00:00.000Z", "share-target");

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after source membership becomes inactive", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("UPDATE restaurant_memberships SET active = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(0, "a1", sharedTargetUuid);

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after source membership role changes", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("kitchen", "a1", sharedTargetUuid);

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after worker leaves owner account", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner-a", sharedTargetUuid);

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after worker account is inactive", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("UPDATE users SET active = ? WHERE id = ?").run(0, sharedTargetUuid);

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after source restaurant leaves owner", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a1");

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after target restaurant leaves owner", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", "a2");

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target without target worker profile", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("DELETE FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
      .run("a2", sharedTargetUuid);

    await expectSharedTargetRequestRejected();
  });

  test("POST /request rejects stale accepted shared target after direct target membership is created", async () => {
    seedAcceptedSharedTarget();
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("a2", sharedTargetUuid, "manager", null, 1);

    await expectSharedTargetRequestRejected();
  });

  test("POST /respond/:id rejects stale direct offers without mutating replacement state", async () => {
    rawDb.prepare(`
      INSERT INTO replacement_requests (
        id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("repl-direct-stale", "worker-a", activeServiceUuid, targetWorkerUuid, "a2", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify([targetWorkerUuid]), JSON.stringify([]));
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("target-conflict", targetWorkerUuid, "a2", "2026-05-23", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/services/replacement/respond/repl-direct-stale", {
      method: "POST",
      headers: { cookie: "session=session-target", "content-type": "application/json" },
      body: JSON.stringify({ response: "rejected" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Ce remplacement n'est plus disponible pour vous" });
    const row = rawDb.query("SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id = ?")
      .get("repl-direct-stale") as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: targetWorkerUuid, rejected_candidate_ids: JSON.stringify([]) });
  });

  test("POST /respond/:id rejects stale broadcast offers without mutating replacement state", async () => {
    rawDb.prepare(`
      INSERT INTO replacement_requests (
        id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("repl-broadcast-stale", "worker-a", activeServiceUuid, "a2", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify([targetWorkerUuid]), JSON.stringify([]));
    rawDb.prepare(`
      INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("target-conflict", targetWorkerUuid, "a2", "2026-05-23", "10:00", "14:00", "floor", "scheduled");

    const res = await app.request("/services/replacement/respond/repl-broadcast-stale", {
      method: "POST",
      headers: { cookie: "session=session-target", "content-type": "application/json" },
      body: JSON.stringify({ response: "rejected" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Ce remplacement n'est plus disponible pour vous" });
    const row = rawDb.query("SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id = ?")
      .get("repl-broadcast-stale") as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify([]) });
  });

  test("POST /respond/:id does not let a rejected broadcast candidate accept later", async () => {
    rawDb.prepare(`
      INSERT INTO replacement_requests (
        id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("repl-broadcast-rejected", "worker-a", activeServiceUuid, "a2", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify([targetWorkerUuid]), JSON.stringify([targetWorkerUuid]));

    const res = await app.request("/services/replacement/respond/repl-broadcast-rejected", {
      method: "POST",
      headers: { cookie: "session=session-target", "content-type": "application/json" },
      body: JSON.stringify({ response: "accepted" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only the picked candidate can respond to this replacement" });
    const service = rawDb.query("SELECT worker_id FROM services WHERE id = ?").get(activeServiceUuid) as any;
    expect(service.worker_id).toBe("worker-a");
    const row = rawDb.query("SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id = ?")
      .get("repl-broadcast-rejected") as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify([targetWorkerUuid]) });
  });

  test("POST /respond/:id does not let a rejected broadcast candidate reject again", async () => {
    rawDb.prepare(`
      INSERT INTO replacement_requests (
        id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, rejected_candidate_ids
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("repl-broadcast-rejected", "worker-a", activeServiceUuid, "a2", "awaiting_worker_reply", "2099-01-01T00:00:00.000Z", JSON.stringify([targetWorkerUuid]), JSON.stringify([targetWorkerUuid]));

    const res = await app.request("/services/replacement/respond/repl-broadcast-rejected", {
      method: "POST",
      headers: { cookie: "session=session-target", "content-type": "application/json" },
      body: JSON.stringify({ response: "rejected" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only the picked candidate can respond to this replacement" });
    const row = rawDb.query("SELECT status, target_id, rejected_candidate_ids FROM replacement_requests WHERE id = ?")
      .get("repl-broadcast-rejected") as any;
    expect(row).toEqual({ status: "awaiting_worker_reply", target_id: null, rejected_candidate_ids: JSON.stringify([targetWorkerUuid]) });
  });
});
