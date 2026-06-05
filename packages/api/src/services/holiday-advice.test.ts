import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-holiday-advice-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { computeLeaveBalances } = await import("./holiday-advice.js");

beforeAll(() => {
  rawDb.exec(`
    DROP TABLE IF EXISTS holiday_requests;
    DROP TABLE IF EXISTS worker_share_authorizations;
    DROP TABLE IF EXISTS worker_restaurant_profiles;
    DROP TABLE IF EXISTS restaurant_memberships;
    DROP TABLE IF EXISTS owner_memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    DROP TABLE IF EXISTS owners;
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
      phone TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      start_date TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  `);
});

beforeEach(() => {
  setSystemTime(new Date("2026-05-19T12:00:00Z"));
  rawDb.exec("DELETE FROM holiday_requests; DELETE FROM worker_share_authorizations; DELETE FROM worker_restaurant_profiles; DELETE FROM restaurant_memberships; DELETE FROM owner_memberships; DELETE FROM users; DELETE FROM restaurants; DELETE FROM owners;");
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-1", "Owner");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name) VALUES (?, ?, ?)").run("resto-1", "owner-1", "Resto");
});

afterAll(() => {
  setSystemTime();
});

describe("computeLeaveBalances", () => {
  function insertWorker(startDate: string, createdAt: string) {
    rawDb.prepare(`
      INSERT INTO users (id, name, role, restaurant_id, start_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("worker-1", "Grand Brasserie Worker", "floor", "resto-1", startDate, createdAt);
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("resto-1", "worker-1", "floor", 1);
  }

  test("uses employment start date for earned CP instead of row creation date", () => {
    insertWorker("2025-12-01", "2026-05-19T09:00:00.000Z");
    rawDb.prepare(`
      INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, medical, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("hol-1", "worker-1", "resto-1", "2026-02-03", "2026-02-04", 0, "approved");

    expect(computeLeaveBalances("resto-1")).toEqual([
      expect.objectContaining({
        workerId: "worker-1",
        earnedDays: 12.5,
        takenDays: 2,
        remainingDays: 10.5,
      }),
    ]);
  });

  test("does not count approved medical leave as CP taken", () => {
    insertWorker("2025-12-01", new Date().toISOString());
    rawDb.prepare(`
      INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, medical, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("hol-med", "worker-1", "resto-1", "2026-05-12", "2026-05-12", 1, "approved");

    expect(computeLeaveBalances("resto-1")[0]).toEqual(expect.objectContaining({
      earnedDays: 12.5,
      takenDays: 0,
      remainingDays: 12.5,
    }));
  });

  test("does not mark current-period balance as expiring when prior carryover was consumed", () => {
    insertWorker("2025-01-01", new Date().toISOString());
    const insertHoliday = rawDb.prepare(`
      INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, medical, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertHoliday.run("hol-1", "worker-1", "resto-1", "2025-06-02", "2025-06-07", 0, "approved");
    insertHoliday.run("hol-2", "worker-1", "resto-1", "2025-07-07", "2025-07-12", 0, "approved");
    insertHoliday.run("hol-3", "worker-1", "resto-1", "2025-08-04", "2025-08-09", 0, "approved");
    insertHoliday.run("hol-4", "worker-1", "resto-1", "2025-09-01", "2025-09-02", 0, "approved");

    expect(computeLeaveBalances("resto-1")[0]).toEqual(expect.objectContaining({
      earnedDays: 27.5,
      takenDays: 20,
      remainingDays: 7.5,
      expiringDays: 0,
      expiringSoon: false,
    }));
  });

  test("marks only prior-period carryover as expiring near May 31", () => {
    insertWorker("2025-01-01", new Date().toISOString());
    rawDb.prepare(`
      INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, medical, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("hol-1", "worker-1", "resto-1", "2025-06-02", "2025-06-06", 0, "approved");

    expect(computeLeaveBalances("resto-1")[0]).toEqual(expect.objectContaining({
      earnedDays: 27.5,
      takenDays: 5,
      remainingDays: 22.5,
      expiringDays: 7.5,
      expiringSoon: true,
    }));
  });

  test("does not create May 31 carryover for a worker who joined during the current period", () => {
    rawDb.prepare(`
      INSERT INTO users (id, name, role, restaurant_id, start_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("worker-1", "New Worker", "kitchen", "resto-1", "2026-02-02", new Date().toISOString());
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("resto-1", "worker-1", "kitchen", 1);
    rawDb.prepare(`
      INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, medical, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("hol-1", "worker-1", "resto-1", "2026-03-02", "2026-03-05", 0, "approved");

    expect(computeLeaveBalances("resto-1")[0]).toEqual(expect.objectContaining({
      earnedDays: 7.5,
      takenDays: 4,
      remainingDays: 3.5,
      expiringDays: 0,
      expiringSoon: false,
    }));
  });

  test("excludes accepted shared workers from target restaurant leave balances", () => {
    insertWorker("2025-12-01", new Date().toISOString());
    rawDb.prepare("INSERT INTO restaurants (id, owner_id, name) VALUES (?, ?, ?)")
      .run("resto-2", "owner-1", "Source Resto");
    rawDb.prepare(`
      INSERT INTO users (id, name, role, restaurant_id, start_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("worker-shared", "Shared Worker", "floor", "resto-2", "2025-06-01", new Date().toISOString());
    rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
      .run("owner-1", "worker-shared", "member");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("resto-2", "worker-shared", "floor", 1);
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, contract_hours, multi_restaurant_willing)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("resto-1", "worker-shared", 1, "[]", 35, 1);
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, worker_consented_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("share-1", "owner-1", "resto-2", "resto-1", "worker-shared", "floor", "accepted", "2026-05-01T09:00:00.000Z", null);
    rawDb.prepare(`
      INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, medical, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("hol-shared", "worker-shared", "resto-1", "2026-04-06", "2026-04-10", 0, "approved");

    expect(computeLeaveBalances("resto-1").map((balance) => balance.workerId)).toEqual(["worker-1"]);
  });
});
