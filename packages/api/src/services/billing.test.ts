import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-billing-owner-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const {
  countActiveForRestaurant,
  countActiveForOwner,
  countActiveEmployees,
  InvalidBillingMonthError,
  resolveBillingMonth,
  stripeSiretMetadataForOwnerScope,
} = await import("./billing.js");

function createSchema() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;

    CREATE TABLE owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stripe_customer_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active'
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
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE services (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed'
    );
  `);
}

beforeEach(() => {
  createSchema();

  rawDb.prepare("INSERT INTO owners (id, name, stripe_customer_id, subscription_status) VALUES (?, ?, ?, ?)")
    .run("owner-a", "Owner A", "cus_owner_a", "active");
  rawDb.prepare("INSERT INTO owners (id, name, stripe_customer_id, subscription_status) VALUES (?, ?, ?, ?)")
    .run("owner-b", "Owner B", "cus_owner_b", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a1", "owner-a", "Alpha", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a2", "owner-a", "Beta", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("b1", "owner-b", "Gamma", "active");
  rawDb.prepare("INSERT INTO restaurants (id, owner_id, name, status) VALUES (?, ?, ?, ?)")
    .run("a3", "owner-a", "Archived", "inactive");

  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?)")
    .run("worker-shared", "Shared Worker", "floor", "a1", 1);
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?)")
    .run("worker-a1", "A1 Worker", "kitchen", "a1", 1);
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?)")
    .run("worker-inactive", "Inactive Worker", "floor", "a2", 0);
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?)")
    .run("admin-a", "Admin A", "admin", "a1", 1);
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?)")
    .run("worker-b", "B Worker", "floor", "b1", 1);
  rawDb.prepare("INSERT INTO users (id, name, role, restaurant_id, active) VALUES (?, ?, ?, ?, ?)")
    .run("worker-archived", "Archived Worker", "floor", "a3", 1);

  const insertService = rawDb.prepare("INSERT INTO services (id, restaurant_id, worker_id, date, status) VALUES (?, ?, ?, ?, ?)");
  insertService.run("svc-a1-shared", "a1", "worker-shared", "2026-05-03", "confirmed");
  insertService.run("svc-a2-shared", "a2", "worker-shared", "2026-05-04", "confirmed");
  insertService.run("svc-a1-worker", "a1", "worker-a1", "2026-05-05", "confirmed");
  insertService.run("svc-a2-inactive", "a2", "worker-inactive", "2026-05-06", "confirmed");
  insertService.run("svc-a2-cancelled", "a2", "worker-a1", "2026-05-07", "cancelled");
  insertService.run("svc-admin", "a1", "admin-a", "2026-05-08", "confirmed");
  insertService.run("svc-b", "b1", "worker-b", "2026-05-09", "confirmed");
  insertService.run("svc-archived", "a3", "worker-archived", "2026-05-10", "confirmed");
});

describe("owner-level billing active employee counts", () => {
  test("dedupes shared workers across active restaurants in the same owner", () => {
    const result = countActiveForOwner("owner-a", "2026-05");

    expect(result.activeCount).toBe(2);
    expect(result.workers.sort()).toEqual(["A1 Worker", "Shared Worker"]);
    expect(result.restaurants).toEqual([
      {
        restaurantId: "a1",
        restaurantName: "Alpha",
        activeCount: 2,
        workers: ["Shared Worker", "A1 Worker"],
      },
      {
        restaurantId: "a2",
        restaurantName: "Beta",
        activeCount: 1,
        workers: ["Shared Worker"],
      },
    ]);
  });

  test("restaurant count ignores inactive workers", () => {
    const result = countActiveForRestaurant("a2", "2026-05");

    expect(result.activeCount).toBe(1);
    expect(result.workers).toEqual(["Shared Worker"]);
  });

  test("reports one Stripe usage record per owner account", () => {
    const reports = countActiveEmployees("2026-05");

    expect(reports.map((report: any) => ({
      ownerId: report.ownerId,
      stripeCustomerId: report.stripeCustomerId,
      activeCount: report.activeCount,
    }))).toEqual([
      { ownerId: "owner-a", stripeCustomerId: "cus_owner_a", activeCount: 2 },
      { ownerId: "owner-b", stripeCustomerId: "cus_owner_b", activeCount: 1 },
    ]);
  });

  test("does not report usage for cancelled or unpaid owners", () => {
    rawDb.prepare("UPDATE owners SET subscription_status = ? WHERE id = ?").run("cancelled", "owner-b");
    rawDb.prepare("INSERT INTO owners (id, name, stripe_customer_id, subscription_status) VALUES (?, ?, ?, ?)")
      .run("owner-c", "Owner C", "cus_owner_c", "unpaid");

    const reports = countActiveEmployees("2026-05");

    expect(reports.map((report: any) => report.ownerId)).toEqual(["owner-a"]);
  });

  test("rejects malformed billing months", () => {
    expect(() => countActiveForOwner("owner-a", "2026-13")).toThrow(InvalidBillingMonthError);
    expect(() => countActiveForRestaurant("a1", "2026-5")).toThrow(InvalidBillingMonthError);
    expect(() => countActiveEmployees("not-a-month")).toThrow(InvalidBillingMonthError);
  });

  test("resolves only YYYY-MM billing months", () => {
    expect(resolveBillingMonth("2026-05")).toBe("2026-05");
    expect(() => resolveBillingMonth("2026-00")).toThrow(InvalidBillingMonthError);
    expect(() => resolveBillingMonth("2026-12-01")).toThrow(InvalidBillingMonthError);
  });
});

describe("Stripe SIRET metadata", () => {
  test("keeps canonical SIRET only for single-restaurant billing customers", () => {
    expect(stripeSiretMetadataForOwnerScope(1, "12345678901234")).toEqual({
      siret: "12345678901234",
      siret_scope: "single_restaurant",
    });
    expect(stripeSiretMetadataForOwnerScope(1, null)).toEqual({
      siret: "",
      siret_scope: "single_restaurant",
    });
  });

  test("clears canonical SIRET for multi-restaurant billing customers", () => {
    expect(stripeSiretMetadataForOwnerScope(2, "12345678901234")).toEqual({
      siret: "",
      siret_scope: "multi_restaurant",
    });
  });
});
