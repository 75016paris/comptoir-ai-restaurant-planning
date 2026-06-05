import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-payroll-shared-workers-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { computePayroll, payrollToSilae } = await import("./payroll.js");

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS holiday_requests;
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
      name TEXT NOT NULL
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      matricule TEXT
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
      status TEXT NOT NULL,
      worker_consented_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed'
    );

    CREATE TABLE holiday_requests (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      medical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
}

beforeEach(() => {
  createSchema();
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name) VALUES (?, ?, ?)")
    .run("a1", "owner-a", "Source");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name) VALUES (?, ?, ?)")
    .run("a2", "owner-a", "Target");

  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active, matricule) VALUES (?, ?, ?, ?, ?, ?)")
    .run("worker-local", "Local Worker", "floor", "a2", 1, "LOC");
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active, matricule) VALUES (?, ?, ?, ?, ?, ?)")
    .run("worker-shared", "Shared Worker", "floor", "a1", 1, "SHR");
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "worker-shared", "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("a2", "worker-local", "floor", 1);
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
    .run("a1", "worker-shared", "floor", 1);
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, multi_restaurant_willing)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("a2", "worker-shared", 1, "[]", 35, 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, worker_consented_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("share-1", "owner-a", "a1", "a2", "worker-shared", "floor", "accepted", "2026-05-01T09:00:00.000Z", null);

  const insertService = rawDb.prepare(`
    INSERT INTO services (id, restaurant_id, worker_id, date, start_time, end_time, role, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertService.run("svc-local", "a2", "worker-local", "2026-05-04", "10:00", "14:00", "floor", "confirmed");
  insertService.run("svc-shared", "a2", "worker-shared", "2026-05-04", "14:00", "18:00", "floor", "confirmed");
});

describe("computePayroll shared-worker privacy", () => {
  test("excludes accepted shared workers from target restaurant payroll export", () => {
    const payroll = computePayroll("a2", "2026-05");

    expect(payroll.workers.map((worker) => ({
      workerId: worker.workerId,
      name: worker.name,
      totalHours: worker.totalHours,
    }))).toEqual([
      { workerId: "worker-local", name: "Local Worker", totalHours: 4 },
    ]);
  });

  test("source restaurant payroll includes shared target services with analytical section", () => {
    const payroll = computePayroll("a1", "2026-05");

    expect(payroll.workers.map((worker) => ({
      workerId: worker.workerId,
      totalHours: worker.totalHours,
      analytics: worker.analytics,
    }))).toEqual([
      {
        workerId: "worker-shared",
        totalHours: 4,
        analytics: [{
          restaurantId: "a2",
          restaurantName: "Target",
          serviceCount: 1,
          daysWorked: 1,
          totalHours: 4,
          baseHours: 4,
          ot110: 0,
          ot120: 0,
          ot150: 0,
        }],
      },
    ]);

    expect(payrollToSilae(payroll)).toContain("SHR;HS-HN;4,00;01/05/2026;;Target");
  });
});
