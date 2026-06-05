import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-dpae-shared-workers-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { generateDpaeRows } = await import("./dpae-export.js");

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
      siret TEXT,
      address TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      sub_roles TEXT NOT NULL DEFAULT '[]',
      date_of_birth TEXT,
      birth_place TEXT,
      nationality TEXT,
      nir TEXT,
      address TEXT,
      contract_type TEXT,
      hcr_level TEXT,
      start_date TEXT,
      contract_end_date TEXT,
      contract_hours INTEGER,
      hourly_rate INTEGER,
      active INTEGER NOT NULL DEFAULT 1
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
}

beforeEach(() => {
  createSchema();
  rawDb.prepare("INSERT INTO owners (id, name) VALUES (?, ?)").run("owner-a", "Owner A");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, siret, address) VALUES (?, ?, ?, ?, ?)")
    .run("a1", "owner-a", "Source", "11111111111111", "1 Source Street");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, siret, address) VALUES (?, ?, ?, ?, ?)")
    .run("a2", "owner-a", "Target", "22222222222222", "2 Target Street");

  const insertUser = rawDb.prepare(`
    INSERT INTO users (
      id, name, first_name, last_name, role, restaurant_id, sub_roles, date_of_birth, birth_place,
      nationality, nir, address, contract_type, hcr_level, start_date, contract_hours, hourly_rate, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertUser.run(
    "worker-local",
    "Local Worker",
    "Local",
    "Worker",
    "floor",
    "a2",
    '["Serveur"]',
    "1990-01-01",
    "Paris",
    "FR",
    "1900101000000",
    "10 Local Street",
    "CDI",
    "I-1",
    "2026-01-01",
    35,
    1200,
    1,
  );
  insertUser.run(
    "worker-shared",
    "Shared Worker",
    "Shared",
    "Worker",
    "floor",
    "a1",
    '["SourceOnly"]',
    "1988-02-02",
    "Lyon",
    "FR",
    "1880202000000",
    "20 Source Street",
    "CDI",
    "II-1",
    "2025-01-01",
    39,
    1500,
    1,
  );

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
});

describe("generateDpaeRows shared-worker privacy", () => {
  test("excludes accepted shared workers from target restaurant DPAE export", () => {
    const rows = generateDpaeRows({
      restaurantId: "a2",
      workerIds: ["worker-local", "worker-shared"],
    });

    expect(rows.map((row) => ({
      workerFirstName: row.workerFirstName,
      workerLastName: row.workerLastName,
      workerNir: row.workerNir,
      workerAddress: row.workerAddress,
    }))).toEqual([
      {
        workerFirstName: "Local",
        workerLastName: "Worker",
        workerNir: "1900101000000",
        workerAddress: "10 Local Street",
      },
    ]);
  });
});
