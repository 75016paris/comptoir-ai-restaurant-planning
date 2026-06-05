import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-restaurant-context-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const {
  listAccessibleRestaurants,
  resolveRestaurantContext,
  resolveSharedWorkerRestaurantContext,
  userCanBeScheduledInRestaurant,
  userHasActiveRestaurantMembership,
} = await import("./restaurant-context.js");
const { collectMultiRestaurantBackfillFailures } = await import("./multi-restaurant-backfill-check.js");

function resetDb() {
  rawDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS whatsapp_context_sessions;
    DROP TABLE IF EXISTS onboarding_tokens;
    DROP TABLE IF EXISTS legal_acceptances;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS worker_share_authorizations;
    DROP TABLE IF EXISTS worker_restaurant_profiles;
    DROP TABLE IF EXISTS restaurant_memberships;
    DROP TABLE IF EXISTS owner_memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS restaurants;
    DROP TABLE IF EXISTS owners;
    PRAGMA foreign_keys = ON;
  `);
}

function createV1Schema() {
  rawDb.exec(`
    CREATE TABLE restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      status TEXT NOT NULL DEFAULT 'active',
      onboarding_completed_at TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active',
      subscription_period_end TEXT,
      trial_ends_at TEXT,
      cancel_at TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      permissions TEXT,
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
      multi_restaurant_willing INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function seedV1Rows() {
  rawDb.prepare(`
    INSERT INTO restaurants (
      id, name, timezone, status, onboarding_completed_at, stripe_customer_id,
      stripe_subscription_id, subscription_status, subscription_period_end, trial_ends_at, cancel_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("resto-1", "Alpha", "Europe/Paris", "active", "2026-05-01T00:00:00.000Z", "cus_1", "sub_1", "trialing", "2026-06-01", "2026-05-31", null);

  rawDb.prepare(`
    INSERT INTO restaurants (
      id, name, timezone, status, onboarding_completed_at, stripe_customer_id,
      stripe_subscription_id, subscription_status, subscription_period_end, trial_ends_at, cancel_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("resto-2", "Bravo", "Europe/Paris", "active", null, null, null, "active", null, null, null);

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, priority, sub_roles,
      contract_type, contract_hours, contract_end_date, max_weekly_hours,
      admin_ot_override, hcr_level, hourly_rate, matricule, manager_notes,
      multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("admin-1", "Admin One", "admin@example.com", "admin", "resto-1", 1, '{"settings":true}', 1, "[]", null, null, null, null, null, null, null, null, null, 0);

  rawDb.prepare(`
    INSERT INTO users (
      id, name, email, role, restaurant_id, active, permissions, priority, sub_roles,
      contract_type, contract_hours, contract_end_date, max_weekly_hours,
      admin_ot_override, hcr_level, hourly_rate, matricule, manager_notes,
      multi_restaurant_willing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("worker-1", "Worker One", "worker@example.com", "kitchen", "resto-1", 1, null, 2, '["Chef"]', "CDI", 39, null, 44, 46, "III-2", 1800, "M001", "Strong mornings", 1);
}

function applyPhase0Migration() {
  const migration = readMigration("0115_multi_restaurant_foundation.sql");
  rawDb.exec(migration);
}

function readMigration(fileName: string) {
  return readFileSync(new URL(`../../drizzle/${fileName}`, import.meta.url), "utf8");
}

function applyMigration(fileName: string) {
  rawDb.exec(readMigration(fileName));
}

function seedAcceptedShareSchedulingContext(role: "kitchen" | "floor" = "kitchen") {
  createV1Schema();
  seedV1Rows();
  applyPhase0Migration();
  applyMigration("0120_worker_share_authorizations.sql");

  rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-1", "resto-2");
  rawDb.prepare(`
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, multi_restaurant_willing)
    VALUES (?, ?, ?, ?, ?)
  `).run("resto-2", "worker-1", 1, "[]", 1);
  rawDb.prepare(`
    INSERT INTO worker_share_authorizations (
      id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
      invited_by_user_id, worker_consented_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "share-worker-1-resto-2",
    "owner_resto-1",
    "resto-1",
    "resto-2",
    "worker-1",
    role,
    "accepted",
    "admin-1",
    "2026-05-24T00:00:00.000Z",
  );
}

function tableColumns(tableName: string) {
  return (rawDb.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function indexNames(tableName: string) {
  return (rawDb.query(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>).map((index) => index.name);
}

beforeEach(() => {
  resetDb();
});

afterAll(() => {
  resetDb();
});

describe("restaurant context compatibility helpers", () => {
  test("fall back to users.restaurant_id before membership tables exist", () => {
    createV1Schema();
    seedV1Rows();

    const restaurants = listAccessibleRestaurants("admin-1");

    expect(restaurants).toEqual([
      {
        id: "resto-1",
        ownerId: "resto-1",
        name: "Alpha",
        status: "active",
        timezone: "Europe/Paris",
        onboardingCompletedAt: "2026-05-01T00:00:00.000Z",
        role: "admin",
        ownerRole: "owner_admin",
        permissions: '{"settings":true}',
        active: true,
      },
    ]);
  });

  test("read v2 restaurant memberships when present", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-1", "resto-2");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("resto-2", "admin-1", "manager", '{"planning":true}', 1);

    const restaurants = listAccessibleRestaurants("admin-1");

    expect(restaurants.map((restaurant) => ({
      id: restaurant.id,
      ownerId: restaurant.ownerId,
      role: restaurant.role,
      ownerRole: restaurant.ownerRole,
      permissions: restaurant.permissions,
    }))).toEqual([
      { id: "resto-1", ownerId: "owner_resto-1", role: "admin", ownerRole: "owner_admin", permissions: '{"settings":true}' },
      { id: "resto-2", ownerId: "owner_resto-1", role: "manager", ownerRole: "owner_admin", permissions: '{"planning":true}' },
    ]);
  });

  test("resolveRestaurantContext only returns restaurants the user can access", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();

    expect(resolveRestaurantContext("admin-1", "resto-1")?.restaurantId).toBe("resto-1");
    expect(resolveRestaurantContext("admin-1", "resto-2")).toBeNull();
  });

  test("resolveSharedWorkerRestaurantContext returns accepted same-owner target context only", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();
    applyMigration("0120_worker_share_authorizations.sql");

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-1", "resto-2");
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (
        restaurant_id, user_id, priority, sub_roles, contract_hours, max_weekly_hours, multi_restaurant_willing
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("resto-2", "worker-1", 2, '["Salle"]', 35, 48, 1);
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
        invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "share-worker-1-resto-2",
      "owner_resto-1",
      "resto-1",
      "resto-2",
      "worker-1",
      "kitchen",
      "accepted",
      "admin-1",
      "2026-05-24T00:00:00.000Z",
    );

    const context = resolveSharedWorkerRestaurantContext("worker-1", "resto-2");

    expect(context).toMatchObject({
      id: "resto-2",
      restaurantId: "resto-2",
      ownerId: "owner_resto-1",
      role: "kitchen",
      ownerRole: "member",
      permissions: "{}",
      active: true,
    });
    expect(resolveRestaurantContext("worker-1", "resto-2")).toBeNull();

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("resto-2", "worker-1", "floor", null, 1);

    expect(resolveSharedWorkerRestaurantContext("worker-1", "resto-2")).toBeNull();
    expect(resolveRestaurantContext("worker-1", "resto-2")?.restaurantId).toBe("resto-2");
  });

  test("resolveSharedWorkerRestaurantContext fails closed on unconsented or drifted shares", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();
    applyMigration("0120_worker_share_authorizations.sql");

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-1", "resto-2");
    rawDb.prepare(`
      INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, multi_restaurant_willing)
      VALUES (?, ?, ?, ?, ?)
    `).run("resto-2", "worker-1", 1, "[]", 1);
    rawDb.prepare(`
      INSERT INTO worker_share_authorizations (
        id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status,
        invited_by_user_id, worker_consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("share-worker-1-resto-2", "owner_resto-1", "resto-1", "resto-2", "worker-1", "kitchen", "accepted", "admin-1", null);

    expect(resolveSharedWorkerRestaurantContext("worker-1", "resto-2")).toBeNull();

    rawDb.prepare("UPDATE worker_share_authorizations SET worker_consented_at = ? WHERE id = ?")
      .run("2026-05-24T00:00:00.000Z", "share-worker-1-resto-2");
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-2", "resto-2");

    expect(resolveSharedWorkerRestaurantContext("worker-1", "resto-2")).toBeNull();
  });

  test("userHasActiveRestaurantMembership follows v2 memberships instead of legacy restaurant_id", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();

    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-1", "resto-2");
    rawDb.prepare("UPDATE users SET restaurant_id = ? WHERE id = ?").run("resto-1", "worker-1");
    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES (?, ?, ?, ?)")
      .run("resto-2", "worker-1", "floor", 1);

    expect(userHasActiveRestaurantMembership("worker-1", "resto-2", ["floor"])).toBe(true);
    expect(userHasActiveRestaurantMembership("worker-1", "resto-2", ["kitchen"])).toBe(false);
    expect(userHasActiveRestaurantMembership("worker-1", "missing", ["floor"])).toBe(false);
  });

  test("userCanBeScheduledInRestaurant validates accepted share role and direct-membership retirement", () => {
    seedAcceptedShareSchedulingContext();

    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(true);
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["floor"])).toBe(false);

    rawDb.prepare("INSERT INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)")
      .run("resto-2", "worker-1", "manager", null, 1);

    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
  });

  test("userCanBeScheduledInRestaurant rejects unconsented or revoked accepted shares", () => {
    seedAcceptedShareSchedulingContext();
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(true);

    rawDb.prepare("UPDATE worker_share_authorizations SET worker_consented_at = NULL WHERE id = ?")
      .run("share-worker-1-resto-2");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);

    rawDb.prepare("UPDATE worker_share_authorizations SET worker_consented_at = ?, revoked_at = ? WHERE id = ?")
      .run("2026-05-24T00:00:00.000Z", "2026-05-25T00:00:00.000Z", "share-worker-1-resto-2");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
  });

  test("userCanBeScheduledInRestaurant rejects inactive or role-drifted source membership", () => {
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("UPDATE restaurant_memberships SET active = ? WHERE restaurant_id = ? AND user_id = ?")
      .run(0, "resto-1", "worker-1");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);

    resetDb();
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("UPDATE restaurant_memberships SET role = ? WHERE restaurant_id = ? AND user_id = ?")
      .run("floor", "resto-1", "worker-1");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
  });

  test("userCanBeScheduledInRestaurant rejects inactive workers and owner-membership loss", () => {
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("UPDATE users SET active = ? WHERE id = ?").run(0, "worker-1");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);

    resetDb();
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("DELETE FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .run("owner_resto-1", "worker-1");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
  });

  test("shared worker scheduling respects the worker-side multi-restaurant opt-in", () => {
    seedAcceptedShareSchedulingContext();
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(true);
    expect(resolveSharedWorkerRestaurantContext("worker-1", "resto-2")).not.toBeNull();

    rawDb.prepare("UPDATE users SET multi_restaurant_willing = ? WHERE id = ?").run(0, "worker-1");

    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
    expect(resolveSharedWorkerRestaurantContext("worker-1", "resto-2")).toBeNull();
  });

  test("userCanBeScheduledInRestaurant rejects source or target owner drift", () => {
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-2", "resto-1");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);

    resetDb();
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("UPDATE restaurants SET owner_id = ? WHERE id = ?").run("owner_resto-2", "resto-2");
    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
  });

  test("userCanBeScheduledInRestaurant rejects missing target profile", () => {
    seedAcceptedShareSchedulingContext();
    rawDb.prepare("DELETE FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
      .run("resto-2", "worker-1");

    expect(userCanBeScheduledInRestaurant("worker-1", "resto-2", ["kitchen"])).toBe(false);
  });
});

describe("multi-restaurant foundation migration", () => {
  test("backfills owners, memberships, and worker profiles from v1 rows", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();

    const owner = rawDb.query("SELECT * FROM owners WHERE id = ?").get("owner_resto-1") as any;
    expect(owner.name).toBe("Alpha");
    expect(owner.stripe_customer_id).toBe("cus_1");
    expect(owner.subscription_status).toBe("trialing");

    const restaurant = rawDb.query("SELECT owner_id FROM restaurants WHERE id = ?").get("resto-1") as any;
    expect(restaurant.owner_id).toBe("owner_resto-1");

    const ownerMembership = rawDb.query("SELECT role FROM owner_memberships WHERE owner_id = ? AND user_id = ?")
      .get("owner_resto-1", "admin-1") as any;
    expect(ownerMembership.role).toBe("owner_admin");

    const restaurantMembership = rawDb.query("SELECT role, permissions, active FROM restaurant_memberships WHERE restaurant_id = ? AND user_id = ?")
      .get("resto-1", "admin-1") as any;
    expect(restaurantMembership).toEqual({ role: "admin", permissions: '{"settings":true}', active: 1 });

    const profile = rawDb.query("SELECT * FROM worker_restaurant_profiles WHERE restaurant_id = ? AND user_id = ?")
      .get("resto-1", "worker-1") as any;
    expect(profile.priority).toBe(2);
    expect(profile.sub_roles).toBe('["Chef"]');
    expect(profile.contract_type).toBe("CDI");
    expect(profile.contract_hours).toBe(39);
    expect(profile.max_weekly_hours).toBe(44);
    expect(profile.admin_ot_override).toBe(46);
    expect(profile.hcr_level).toBe("III-2");
    expect(profile.hourly_rate).toBe(1800);
    expect(profile.matricule).toBe("M001");
    expect(profile.manager_notes).toBe("Strong mornings");
    expect(profile.multi_restaurant_willing).toBe(1);
  });

  test("active context follow-up migrations backfill legacy rows and create context tables", () => {
    createV1Schema();
    seedV1Rows();
    applyPhase0Migration();

    rawDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE legal_acceptances (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        acceptance_type TEXT NOT NULL,
        terms_version TEXT NOT NULL,
        dpa_version TEXT NOT NULL,
        privacy_version TEXT NOT NULL,
        subprocessors_version TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE onboarding_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
    `);

    rawDb.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
      .run("session-1", "admin-1", "2026-06-01T00:00:00.000Z");
    rawDb.prepare(`
      INSERT INTO legal_acceptances (
        id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legal-1", "resto-1", "admin-1", "owner_terms", "terms-v1", "dpa-v1", "privacy-v1", "subs-v1");
    rawDb.prepare("INSERT INTO onboarding_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)")
      .run("token-1", "worker-1", "tok_1", "2026-06-01T00:00:00.000Z");

    applyMigration("0116_active_restaurant_context.sql");
    applyMigration("0117_owner_legal_acceptances.sql");
    applyMigration("0118_whatsapp_context_sessions.sql");
    applyMigration("0119_onboarding_token_restaurant_context.sql");
    applyMigration("0120_worker_share_authorizations.sql");

    const session = rawDb.query("SELECT active_restaurant_id FROM sessions WHERE id = ?").get("session-1") as any;
    expect(session.active_restaurant_id).toBe("resto-1");

    const legal = rawDb.query("SELECT owner_id FROM legal_acceptances WHERE id = ?").get("legal-1") as any;
    expect(legal.owner_id).toBe("owner_resto-1");

    const token = rawDb.query("SELECT restaurant_id FROM onboarding_tokens WHERE id = ?").get("token-1") as any;
    expect(token.restaurant_id).toBe("resto-1");

    rawDb.prepare(`
      INSERT INTO whatsapp_context_sessions (phone, user_id, restaurant_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run("+33600000001", "admin-1", "resto-1", "2026-06-01T00:00:00.000Z");

    const whatsappContext = rawDb.query(`
      SELECT user_id AS userId, restaurant_id AS restaurantId
      FROM whatsapp_context_sessions
      WHERE phone = ?
    `).get("+33600000001") as any;
    expect(whatsappContext).toEqual({ userId: "admin-1", restaurantId: "resto-1" });

    expect(tableColumns("owners")).toContain("stripe_subscription_id");
    expect(tableColumns("restaurants")).toContain("owner_id");
    expect(tableColumns("sessions")).toContain("active_restaurant_id");
    expect(tableColumns("legal_acceptances")).toContain("owner_id");
    expect(tableColumns("onboarding_tokens")).toContain("restaurant_id");
    expect(tableColumns("whatsapp_context_sessions")).toEqual([
      "phone",
      "user_id",
      "restaurant_id",
      "selected_at",
      "expires_at",
    ]);
    expect(tableColumns("worker_share_authorizations")).toEqual([
      "id",
      "owner_id",
      "source_restaurant_id",
      "target_restaurant_id",
      "user_id",
      "role",
      "status",
      "invited_by_user_id",
      "worker_consented_at",
      "revoked_at",
      "created_at",
      "updated_at",
    ]);
    expect(indexNames("restaurants")).toContain("idx_restaurants_owner_id");
    expect(indexNames("owner_memberships")).toContain("idx_owner_memberships_user");
    expect(indexNames("restaurant_memberships")).toContain("idx_restaurant_memberships_user");
    expect(indexNames("sessions")).toContain("idx_sessions_active_restaurant_id");
    expect(indexNames("legal_acceptances")).toContain("idx_legal_acceptances_owner_type");
    expect(indexNames("legal_acceptances")).toContain("idx_legal_acceptances_owner_terms_version");
    expect(indexNames("whatsapp_context_sessions")).toContain("idx_whatsapp_context_sessions_expires_at");
    expect(indexNames("onboarding_tokens")).toContain("idx_onboarding_tokens_restaurant_id");
    expect(indexNames("worker_share_authorizations")).toContain("idx_worker_share_authorizations_owner_target");
    expect(collectMultiRestaurantBackfillFailures(rawDb)).toEqual([]);
  });
});
