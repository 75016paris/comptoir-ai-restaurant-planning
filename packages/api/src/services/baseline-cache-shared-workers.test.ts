import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-baseline-cache-shared-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { loadSolverFingerprint } = await import("./baseline-cache.js");

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS worker_preferred_schedule;
    DROP TABLE IF EXISTS worker_restrictions;
    DROP TABLE IF EXISTS worker_availability;
    DROP TABLE IF EXISTS staffing_schedule;
    DROP TABLE IF EXISTS staffing_targets;
    DROP TABLE IF EXISTS service_template_overrides;
    DROP TABLE IF EXISTS service_templates;
    DROP TABLE IF EXISTS staffing_profiles;
    DROP TABLE IF EXISTS worker_share_authorizations;
    DROP TABLE IF EXISTS worker_restaurant_profiles;
    DROP TABLE IF EXISTS restaurant_memberships;
    DROP TABLE IF EXISTS owner_memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    PRAGMA foreign_keys = ON;

    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      open_days TEXT NOT NULL DEFAULT '{}',
      disabled_compliance_rules TEXT NOT NULL DEFAULT '[]',
      overtime_mode TEXT NOT NULL DEFAULT 'flexible',
      overtime_weekly_cap INTEGER NOT NULL DEFAULT 48,
      overtime_distribution TEXT NOT NULL DEFAULT 'willing-first',
      kitchen_sub_roles TEXT NOT NULL DEFAULT '[]',
      floor_sub_roles TEXT NOT NULL DEFAULT '[]',
      preferred_style TEXT,
      custom_weights TEXT,
      worker_preferences_enabled INTEGER NOT NULL DEFAULT 1,
      hcr_grid TEXT NOT NULL DEFAULT '{}',
      subrole_hcr_map TEXT NOT NULL DEFAULT '{}',
      cache_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      sub_role TEXT,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      contract_hours INTEGER,
      max_weekly_hours INTEGER,
      admin_ot_override INTEGER,
      contract_end_date TEXT,
      hcr_level TEXT,
      overtime_willing INTEGER NOT NULL DEFAULT 0,
      coupure_willing INTEGER NOT NULL DEFAULT 0,
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      inactive_from TEXT,
      inactive_until TEXT
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

    CREATE TABLE staffing_profiles (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      day_priorities TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE service_templates (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE service_template_overrides (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );

    CREATE TABLE staffing_targets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT,
      day_of_week INTEGER NOT NULL,
      role TEXT NOT NULL,
      zone TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      role_breakdown TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE staffing_schedule (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      week INTEGER NOT NULL
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
      effective_from TEXT,
      effective_until TEXT
    );

    CREATE TABLE worker_preferred_schedule (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      midi INTEGER NOT NULL DEFAULT 0,
      soir INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function seedBaseRows() {
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name) VALUES (?, ?, ?)")
    .run("target-r", "owner-a", "Target");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name) VALUES (?, ?, ?)")
    .run("source-r", "owner-a", "Source");
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active, overtime_willing) VALUES (?, ?, ?, ?, ?, ?)")
    .run("worker-shared", "Shared Worker", "floor", "source-r", 1, 1);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-shared", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("source-r", "worker-shared", "floor", 1);
}

function seedAcceptedShare() {
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (
      restaurant_id, user_id, priority, sub_roles, contract_type, contract_hours,
      max_weekly_hours, admin_ot_override, hcr_level, hourly_rate, multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("target-r", "worker-shared", 1, '["Renfort"]', "CDI", 24, 35, 35, "II-1", 1800, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role,
      status, invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-1", "owner-a", "source-r", "target-r", "worker-shared", "floor", "accepted", "admin-a", "2026-05-01T00:00:00.000Z");
}

beforeEach(() => {
  createSchema();
  seedBaseRows();
});

describe("loadSolverFingerprint shared-worker inputs", () => {
  test("accepted worker-share rows affect the workers checksum", () => {
    const before = loadSolverFingerprint("target-r").workersChecksum;
    seedAcceptedShare();
    const after = loadSolverFingerprint("target-r").workersChecksum;

    expect(after).not.toBe(before);
  });

  test("revoking an accepted worker-share row affects the workers checksum", () => {
    seedAcceptedShare();
    const accepted = loadSolverFingerprint("target-r").workersChecksum;
    rawDb.prepare("UPDATE worker_share_authorizations SET revoked_at = ? WHERE id = ?")
      .run("2026-05-02T00:00:00.000Z", "share-1");
    const revoked = loadSolverFingerprint("target-r").workersChecksum;

    expect(revoked).not.toBe(accepted);
  });

  test("target worker profile changes affect the workers checksum", () => {
    seedAcceptedShare();
    const before = loadSolverFingerprint("target-r").workersChecksum;
    rawDb.prepare("UPDATE worker_restaurant_profiles SET contract_hours = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(30, "target-r", "worker-shared");
    const after = loadSolverFingerprint("target-r").workersChecksum;

    expect(after).not.toBe(before);
  });

  test("direct target membership removes stale worker-share inputs from the checksum", () => {
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("target-r", "worker-shared", "floor", 1);
    const directMemberOnly = loadSolverFingerprint("target-r").workersChecksum;
    seedAcceptedShare();
    const directMemberWithStaleShare = loadSolverFingerprint("target-r").workersChecksum;

    expect(directMemberWithStaleShare).toBe(directMemberOnly);
  });
});
