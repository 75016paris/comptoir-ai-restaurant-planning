import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-monthly-digest-shared-workers-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { contractsEndingInRange } = await import("./monthly-digest.js");

beforeEach(() => {
  createSchema();
  seedOwnerAndRestaurants();
});

describe("monthly digest shared-worker privacy", () => {
  test("contract-ending alerts stay limited to direct target restaurant memberships", () => {
    insertWorker("worker-a1", "Worker A1", "a1", "CDD", "2026-06-10");
    insertWorker("worker-a2", "Worker A2", "a2", "saisonnier", "2026-06-20");
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (
        restaurant_id, user_id, priority, sub_roles, contract_type, contract_hours, contract_end_date, multi_restaurant_willing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("a2", "worker-a1", 1, "[]", "CDD", 24, "2026-06-15", 1);
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("share-a1-a2", "owner-a", "a1", "a2", "worker-a1", "floor", "accepted", "admin-a", "2026-05-01T10:00:00.000Z");

    expect(contractsEndingInRange("a2", "2026-06-01", "2026-06-30")).toEqual([
      { workerName: "Worker A2", type: "saisonnier", endDate: "2026-06-20" },
    ]);
  });
});

function seedOwnerAndRestaurants() {
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "active");
  rawDb.prepare("INSERT INTO users (id, name, email, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?, ?)")
    .run("admin-a", "Admin A", "admin@example.com", "admin", "a1", 1);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", "admin-a", "owner_admin");
}

function insertWorker(
  id: string,
  name: string,
  restaurantId: string,
  contractType: "CDD" | "saisonnier",
  contractEndDate: string,
) {
  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, contract_type, contract_end_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, `${id}@example.com`, "floor", restaurantId, 1, contractType, contractEndDate);
  rawDb.prepare("INSERT INTO owner_memberships (owner_id, user_id, role) VALUES (?, ?, ?)")
    .run("owner-a", id, "member");
  rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
    .run(restaurantId, id, "floor", null, 1);
}

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
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
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      contract_type TEXT,
      contract_end_date TEXT
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
  `);
}
