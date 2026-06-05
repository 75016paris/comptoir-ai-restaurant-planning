import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-open-shifts-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { claimOpenShift, createOpenShift, findClaimableForWorker } = await import("./open-shifts.js");
const { processOpenShiftSolicitations, solicitNextOpenShiftCandidate } = await import("./notifications.js");

const OWNER_ID = "owner-a";
const SOURCE_RESTAURANT_ID = "a1";
const TARGET_RESTAURANT_ID = "a2";
const ADMIN_ID = "admin-a";
const WORKER_ID = "shared-worker";
const SHIFT_DATE = "2099-05-02";

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run(OWNER_ID, "Owner A");
  rawDb.prepare(`
    INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, overtime_weekly_cap)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(SOURCE_RESTAURANT_ID, OWNER_ID, "Alpha", "Europe/Paris", "active", "active", 48);
  rawDb.prepare(`
    INSERT INTO restaurants (id, owner_id, name, timezone, status, subscription_status, overtime_weekly_cap)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(TARGET_RESTAURANT_ID, OWNER_ID, "Beta", "Europe/Paris", "active", "active", 48);

  insertUser(ADMIN_ID, "Admin A", "admin-a@example.com", "admin", TARGET_RESTAURANT_ID);
  insertUser(WORKER_ID, "Shared Worker", "shared-worker@example.com", "floor", SOURCE_RESTAURANT_ID);

  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run(OWNER_ID, ADMIN_ID, "owner_admin");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run(OWNER_ID, WORKER_ID, "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run(TARGET_RESTAURANT_ID, ADMIN_ID, "admin", 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run(SOURCE_RESTAURANT_ID, WORKER_ID, "floor", 1);
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(TARGET_RESTAURANT_ID, WORKER_ID, 1, JSON.stringify(["Chef de rang"]), 35, 48, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-1", OWNER_ID, SOURCE_RESTAURANT_ID, TARGET_RESTAURANT_ID, WORKER_ID, "floor", "accepted", ADMIN_ID, "2099-01-01T00:00:00.000Z");
  rawDb.prepare(`
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("availability-shared-target", WORKER_ID, TARGET_RESTAURANT_ID, 6, 1, 1);
});

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS open_shifts;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS published_weeks;
    DROP TABLE IF EXISTS services;
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
      name TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active',
      subscription_period_end TEXT,
      trial_ends_at TEXT,
      cancel_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      siret TEXT,
      whatsapp_bot_locale TEXT NOT NULL DEFAULT 'fr',
      school_zone TEXT,
      holiday_zone TEXT,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active',
      subscription_period_end TEXT,
      trial_ends_at TEXT,
      cancel_at TEXT,
      cancellation_reason TEXT,
      cancellation_feedback TEXT,
      cancellation_comment TEXT,
      cancellation_requested_at TEXT,
      open_days TEXT NOT NULL DEFAULT '[2,3,4,5,6,7]',
      medical_mode INTEGER NOT NULL DEFAULT 0,
      tap_in_out_enabled INTEGER NOT NULL DEFAULT 0,
      tap_in_out_admin_confirmation INTEGER NOT NULL DEFAULT 0,
      tap_in_out_mode TEXT NOT NULL DEFAULT 'lateness_only',
      tap_in_counts_as_hours INTEGER NOT NULL DEFAULT 0,
      reminder_frequency TEXT NOT NULL DEFAULT 'off',
      color_scheme TEXT NOT NULL DEFAULT 'classic',
      kitchen_color TEXT NOT NULL DEFAULT 'amber',
      floor_color TEXT NOT NULL DEFAULT 'sky',
      worker_preferences_enabled INTEGER NOT NULL DEFAULT 1,
      auto_staffing_weeks INTEGER NOT NULL DEFAULT 3,
      disabled_compliance_rules TEXT NOT NULL DEFAULT '["HCR-L3121-16"]',
      kitchen_sub_roles TEXT NOT NULL DEFAULT '["Chef","Cuisinier"]',
      floor_sub_roles TEXT NOT NULL DEFAULT '["Chef de rang","Serveur"]',
      overtime_mode TEXT NOT NULL DEFAULT 'flexible',
      overtime_weekly_cap INTEGER NOT NULL DEFAULT 48,
      overtime_distribution TEXT NOT NULL DEFAULT 'willing-first',
      hcr_grid TEXT NOT NULL DEFAULT '{}',
      subrole_hcr_map TEXT NOT NULL DEFAULT '{}',
      default_contract_type TEXT NOT NULL DEFAULT 'CDI',
      default_contract_hours INTEGER NOT NULL DEFAULT 35,
      preferred_style TEXT NOT NULL DEFAULT 'equipe-stable',
      custom_weights TEXT,
      latitude REAL,
      longitude REAL,
      cache_version INTEGER NOT NULL DEFAULT 0,
      revenue_per_covered_slot_cents INTEGER,
      onboarding_completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT NOT NULL UNIQUE,
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

    CREATE TABLE open_shifts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      required_sub_roles TEXT NOT NULL DEFAULT '[]',
      message TEXT,
      candidate_ids TEXT NOT NULL DEFAULT '[]',
      rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
      solicited_candidate_ids TEXT NOT NULL DEFAULT '[]',
      last_solicited_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      claimed_at TEXT,
      service_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE published_weeks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      week_date TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function fillSourceWeeklyHoursForSharedWorker() {
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("source-hours-1", SOURCE_RESTAURANT_ID, WORKER_ID, "2099-04-27", "08:00", "23:00", "floor", "scheduled", "manual");
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("source-hours-2", SOURCE_RESTAURANT_ID, WORKER_ID, "2099-04-28", "08:00", "23:00", "floor", "scheduled", "manual");
  rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("source-hours-3", SOURCE_RESTAURANT_ID, WORKER_ID, "2099-04-29", "08:00", "23:00", "floor", "scheduled", "manual");
}

describe("open shifts shared-worker eligibility", () => {
  test("accepted shared worker can claim an open shift in the target restaurant", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });

    expect(created.candidateIds).toEqual([WORKER_ID]);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toMatchObject({
      ok: true,
      restaurantId: TARGET_RESTAURANT_ID,
      adminId: ADMIN_ID,
      workerName: "Shared Worker",
      date: SHIFT_DATE,
    });
    const service = rawDb.query(`
      SELECT worker_id AS workerId, restaurant_id AS restaurantId, date, start_time AS startTime, end_time AS endTime
      FROM services
    `).get() as any;
    expect(service).toEqual({
      workerId: WORKER_ID,
      restaurantId: TARGET_RESTAURANT_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
    });
  });

  test("claim revalidates source-restaurant conflicts before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare(`
      INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("source-conflict", SOURCE_RESTAURANT_ID, WORKER_ID, SHIFT_DATE, "11:00", "15:00", "floor", "scheduled", "manual");

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim rejects workers who already declined the open shift", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare("UPDATE open_shifts SET rejected_candidate_ids = ? WHERE id = ?")
      .run(JSON.stringify([WORKER_ID]), created.id);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates source-restaurant weekly caps before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    fillSourceWeeklyHoursForSharedWorker();

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates source membership role before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("kitchen", SOURCE_RESTAURANT_ID, WORKER_ID);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates inactive source membership before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("UPDATE restaurant_memberships SET active = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(0, SOURCE_RESTAURANT_ID, WORKER_ID);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates inactive worker before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("UPDATE users SET active = ? WHERE id = ?").run(0, WORKER_ID);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates owner membership before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?").run(OWNER_ID, WORKER_ID);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates direct target membership retirement before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, WORKER_ID, "manager", 1);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates source restaurant ownership before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", SOURCE_RESTAURANT_ID);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claim revalidates target restaurant ownership before materialising service", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", TARGET_RESTAURANT_ID);

    const result = claimOpenShift(created.id, WORKER_ID);

    expect(result).toEqual({ ok: false, reason: "not_eligible" });
    const serviceCount = rawDb.query("SELECT COUNT(*) AS count FROM services WHERE restaurant_id = ?")
      .get(TARGET_RESTAURANT_ID) as { count: number };
    expect(serviceCount.count).toBe(0);
    const shift = rawDb.query("SELECT status, claimed_by AS claimedBy FROM open_shifts WHERE id = ?")
      .get(created.id) as any;
    expect(shift).toEqual({ status: "open", claimedBy: null });
  });

  test("claimable lookup hides stale shared-worker source ownership", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", SOURCE_RESTAURANT_ID);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker target ownership", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", TARGET_RESTAURANT_ID);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker inactive source membership", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("UPDATE restaurant_memberships SET active = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(0, SOURCE_RESTAURANT_ID, WORKER_ID);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker inactive user", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("UPDATE users SET active = ? WHERE id = ?").run(0, WORKER_ID);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker owner membership loss", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?").run(OWNER_ID, WORKER_ID);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker weekly-cap candidates", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    fillSourceWeeklyHoursForSharedWorker();

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker source role drift", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("kitchen", SOURCE_RESTAURANT_ID, WORKER_ID);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides stale shared-worker direct target membership", () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe(created.id);

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, WORKER_ID, "manager", 1);

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup returns the most recent eligible open shift", () => {
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "older-shift",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "10:00",
      "14:00",
      "floor",
      JSON.stringify([WORKER_ID]),
      `${SHIFT_DATE}T10:00:00`,
      "2099-01-01T09:00:00.000Z",
    );
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "newer-shift",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "15:00",
      "19:00",
      "floor",
      JSON.stringify([WORKER_ID]),
      `${SHIFT_DATE}T15:00:00`,
      "2099-01-01T10:00:00.000Z",
    );

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)?.id).toBe("newer-shift");
  });

  test("claimable lookup hides expired open shifts", () => {
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "expired-shift",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      "2000-05-02",
      "10:00",
      "14:00",
      "floor",
      JSON.stringify([WORKER_ID]),
      "2000-05-02T10:00:00",
      "2000-05-01T10:00:00.000Z",
    );

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("claimable lookup hides shifts already rejected by the worker", () => {
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, rejected_candidate_ids, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "rejected-shift",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "10:00",
      "14:00",
      "floor",
      JSON.stringify([WORKER_ID]),
      JSON.stringify([WORKER_ID]),
      `${SHIFT_DATE}T10:00:00`,
      "2099-01-01T10:00:00.000Z",
    );

    expect(findClaimableForWorker(TARGET_RESTAURANT_ID, WORKER_ID)).toBeNull();
  });

  test("solicitation skips stale shared-worker source ownership", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", SOURCE_RESTAURANT_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker target ownership", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", TARGET_RESTAURANT_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker weekly-cap candidates", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    fillSourceWeeklyHoursForSharedWorker();

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker inactive source membership", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("UPDATE restaurant_memberships SET active = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(0, SOURCE_RESTAURANT_ID, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker source role drift", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("kitchen", SOURCE_RESTAURANT_ID, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker inactive user", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("UPDATE users SET active = ? WHERE id = ?").run(0, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker owner membership loss", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?").run(OWNER_ID, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation skips stale shared-worker direct target membership", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, WORKER_ID, "manager", 1);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift).toEqual({ status: "expired", solicitedCandidateIds: "[]", lastSolicitedAt: null });
  });

  test("solicitation timeout expires stale solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", SOURCE_RESTAURANT_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires target-owner-stale solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", TARGET_RESTAURANT_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires weekly-cap-stale solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);
    fillSourceWeeklyHoursForSharedWorker();

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires inactive-source-membership solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);
    rawDb.prepare("UPDATE restaurant_memberships SET active = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(0, SOURCE_RESTAURANT_ID, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires source-role-stale solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("kitchen", SOURCE_RESTAURANT_ID, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires inactive-worker solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);
    rawDb.prepare("UPDATE users SET active = ? WHERE id = ?").run(0, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires owner-membership-stale solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);
    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?").run(OWNER_ID, WORKER_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation timeout expires direct-target-member solicited shared workers without no-response notification", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", created.id);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, WORKER_ID, "manager", 1);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:11:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation expires open shifts with no remaining candidates", async () => {
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "empty-candidates",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "10:00",
      "14:00",
      "floor",
      JSON.stringify([]),
      `${SHIFT_DATE}T10:00:00`,
    );

    const result = await solicitNextOpenShiftCandidate("empty-candidates", new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get("empty-candidates") as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation expires open shifts when all remaining candidates are rejected", async () => {
    insertUser("rejected-worker", "Rejected Worker", "rejected-worker@example.com", "floor", TARGET_RESTAURANT_ID);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, "rejected-worker", "floor", 1);
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, rejected_candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "all-rejected",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "10:00",
      "14:00",
      "floor",
      JSON.stringify(["rejected-worker"]),
      JSON.stringify(["rejected-worker"]),
      `${SHIFT_DATE}T10:00:00`,
    );

    const result = await solicitNextOpenShiftCandidate("all-rejected", new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds
      FROM open_shifts
      WHERE id = ?
    `).get("all-rejected") as any;
    expect(shift.status).toBe("expired");
    expect(JSON.parse(shift.solicitedCandidateIds)).toEqual([]);
  });

  test("solicitation expires open shifts when the creator can no longer be resolved", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("DELETE FROM users WHERE id = ?").run(ADMIN_ID);

    const result = await solicitNextOpenShiftCandidate(created.id, new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("done");
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds
      FROM open_shifts
      WHERE id = ?
    `).get(created.id) as any;
    expect(shift.status).toBe("expired");
    expect(JSON.parse(shift.solicitedCandidateIds)).toEqual([]);
  });

  test("solicitation processor counts broken notification context as done", async () => {
    const created = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    expect(created.candidateIds).toEqual([WORKER_ID]);

    rawDb.prepare("DELETE FROM users WHERE id = ?").run(ADMIN_ID);

    const result = await processOpenShiftSolicitations(new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toEqual({ sent: 0, waiting: 0, done: 1 });
    const shift = rawDb.query("SELECT status FROM open_shifts WHERE id = ?").get(created.id) as any;
    expect(shift).toEqual({ status: "expired" });
  });

  test("solicitation processor preserves separate waiting and done counts", async () => {
    const waiting = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", waiting.id);
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "done-no-candidates",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "18:00",
      "22:00",
      "floor",
      JSON.stringify([]),
      `${SHIFT_DATE}T18:00:00`,
    );

    const result = await processOpenShiftSolicitations(new Date("2099-01-01T00:04:00.000Z"));

    expect(result).toEqual({ sent: 0, waiting: 1, done: 1 });
    const rows = rawDb.query("SELECT id, status FROM open_shifts ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toContainEqual({ id: waiting.id, status: "open" });
    expect(rows).toContainEqual({ id: "done-no-candidates", status: "expired" });
  });

  test("solicitation processor preserves sent, waiting, and done counts in one pass", async () => {
    insertUser("local-worker", "Local Worker", "local-worker@example.com", "floor", TARGET_RESTAURANT_ID);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, "local-worker", "floor", 1);
    const waiting = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    rawDb.prepare(`
      UPDATE open_shifts
      SET solicited_candidate_ids = ?, last_solicited_at = ?
      WHERE id = ?
    `).run(JSON.stringify([WORKER_ID]), "2099-01-01T00:00:00.000Z", waiting.id);
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "done-no-candidates",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "18:00",
      "22:00",
      "floor",
      JSON.stringify([]),
      `${SHIFT_DATE}T18:00:00`,
    );
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "send-live-candidate",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "15:00",
      "17:00",
      "floor",
      JSON.stringify(["local-worker"]),
      `${SHIFT_DATE}T15:00:00`,
    );

    const result = await processOpenShiftSolicitations(new Date("2099-01-01T00:04:00.000Z"));

    expect(result).toEqual({ sent: 1, waiting: 1, done: 1 });
    const rows = rawDb.query(`
      SELECT id, status, solicited_candidate_ids AS solicitedCandidateIds
      FROM open_shifts
      ORDER BY id
    `).all() as Array<{ id: string; status: string; solicitedCandidateIds: string }>;
    expect(rows).toContainEqual({ id: waiting.id, status: "open", solicitedCandidateIds: JSON.stringify([WORKER_ID]) });
    expect(rows).toContainEqual({ id: "done-no-candidates", status: "expired", solicitedCandidateIds: "[]" });
    expect(rows).toContainEqual({ id: "send-live-candidate", status: "open", solicitedCandidateIds: JSON.stringify(["local-worker"]) });
  });

  test("solicitation processor ignores already closed open shifts", async () => {
    const expired = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "10:00",
      endTime: "14:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    const claimed = createOpenShift({
      restaurantId: TARGET_RESTAURANT_ID,
      createdBy: ADMIN_ID,
      date: SHIFT_DATE,
      startTime: "15:00",
      endTime: "18:00",
      role: "floor",
      requiredSubRoles: ["Chef de rang"],
    });
    rawDb.prepare("UPDATE open_shifts SET status = ? WHERE id = ?").run("expired", expired.id);
    rawDb.prepare("UPDATE open_shifts SET status = ? WHERE id = ?").run("claimed", claimed.id);

    const result = await processOpenShiftSolicitations(new Date("2099-01-01T00:04:00.000Z"));

    expect(result).toEqual({ sent: 0, waiting: 0, done: 0 });
    const notifications = rawDb.query("SELECT COUNT(*) AS count FROM notifications").get() as { count: number };
    expect(notifications.count).toBe(0);
    const rows = rawDb.query(`
      SELECT id, status, solicited_candidate_ids AS solicitedCandidateIds
      FROM open_shifts
      ORDER BY id
    `).all() as Array<{ id: string; status: string; solicitedCandidateIds: string }>;
    expect(rows).toContainEqual({ id: expired.id, status: "expired", solicitedCandidateIds: "[]" });
    expect(rows).toContainEqual({ id: claimed.id, status: "claimed", solicitedCandidateIds: "[]" });
  });

  test("solicitation skips stale candidates and notifies the next live worker", async () => {
    insertUser("local-worker", "Local Worker", "local-worker@example.com", "floor", TARGET_RESTAURANT_ID);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, "local-worker", "floor", 1);
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "mixed-candidates",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "10:00",
      "14:00",
      "floor",
      JSON.stringify([WORKER_ID, "local-worker"]),
      `${SHIFT_DATE}T10:00:00`,
    );

    rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-b", "Owner B");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner-b", SOURCE_RESTAURANT_ID);

    const result = await solicitNextOpenShiftCandidate("mixed-candidates", new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("sent");
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get("mixed-candidates") as any;
    expect(shift.status).toBe("open");
    expect(JSON.parse(shift.solicitedCandidateIds)).toEqual(["local-worker"]);
    expect(shift.lastSolicitedAt).toBeTruthy();
  });

  test("solicitation skips rejected candidates and notifies the next live worker", async () => {
    insertUser("first-worker", "First Worker", "first-worker@example.com", "floor", TARGET_RESTAURANT_ID);
    insertUser("second-worker", "Second Worker", "second-worker@example.com", "floor", TARGET_RESTAURANT_ID);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, "first-worker", "floor", 1);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run(TARGET_RESTAURANT_ID, "second-worker", "floor", 1);
    rawDb.prepare(`
      INSERT INTO open_shifts (
        id, restaurant_id, created_by, date, start_time, end_time, role, candidate_ids, rejected_candidate_ids, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "rejected-first",
      TARGET_RESTAURANT_ID,
      ADMIN_ID,
      SHIFT_DATE,
      "10:00",
      "14:00",
      "floor",
      JSON.stringify(["first-worker", "second-worker"]),
      JSON.stringify(["first-worker"]),
      `${SHIFT_DATE}T10:00:00`,
    );

    const result = await solicitNextOpenShiftCandidate("rejected-first", new Date("2099-01-01T00:00:00.000Z"));

    expect(result).toBe("sent");
    const shift = rawDb.query(`
      SELECT status, solicited_candidate_ids AS solicitedCandidateIds, rejected_candidate_ids AS rejectedCandidateIds, last_solicited_at AS lastSolicitedAt
      FROM open_shifts
      WHERE id = ?
    `).get("rejected-first") as any;
    expect(shift.status).toBe("open");
    expect(JSON.parse(shift.rejectedCandidateIds)).toEqual(["first-worker"]);
    expect(JSON.parse(shift.solicitedCandidateIds)).toEqual(["second-worker"]);
    expect(shift.lastSolicitedAt).toBeTruthy();
  });
});

function insertUser(id: string, name: string, email: string, role: string, restaurantId: string) {
  rawDb.prepare(`
    INSERT INTO users (id, name, email, phone, password_hash, role, restaurant_id, active, priority, sub_roles, contract_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, `+33${id}`, "hash", role, restaurantId, 1, 1, JSON.stringify([]), 35);
}
