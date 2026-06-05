import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { collectMultiRestaurantBackfillFailures } from "../src/services/multi-restaurant-backfill-check";

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE owners (
      id text primary key,
      name text
    );

    CREATE TABLE restaurants (
      id text primary key,
      owner_id text
    );

    CREATE TABLE users (
      id text primary key,
      restaurant_id text,
      active integer
    );

    CREATE TABLE owner_memberships (
      owner_id text,
      user_id text,
      role text
    );

    CREATE TABLE restaurant_memberships (
      restaurant_id text,
      user_id text,
      role text,
      active integer
    );

    CREATE TABLE worker_restaurant_profiles (
      restaurant_id text,
      user_id text
    );

    CREATE TABLE worker_share_authorizations (
      id text primary key,
      owner_id text,
      source_restaurant_id text,
      target_restaurant_id text,
      user_id text,
      role text,
      status text
    );

    CREATE TABLE sessions (
      id text primary key,
      user_id text,
      active_restaurant_id text
    );

    CREATE TABLE legal_acceptances (
      id text primary key,
      restaurant_id text,
      owner_id text
    );

    CREATE TABLE onboarding_tokens (
      id text primary key,
      user_id text,
      restaurant_id text
    );

    CREATE TABLE whatsapp_context_sessions (
      phone text primary key,
      restaurant_id text
    );
  `);

  return db;
}

function seedValidBackfill(db: Database) {
  db.exec(`
    INSERT INTO owners (id, name) VALUES ('owner-a', 'Owner A');
    INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
    INSERT INTO users (id, restaurant_id, active) VALUES ('admin-a', 'resto-a', 1);
    INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'admin-a', 'owner_admin');
    INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES ('resto-a', 'admin-a', 'admin', 1);
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id) VALUES ('resto-a', 'admin-a');
    INSERT INTO sessions (id, user_id, active_restaurant_id) VALUES ('session-a', 'admin-a', 'resto-a');
    INSERT INTO legal_acceptances (id, restaurant_id, owner_id) VALUES ('legal-a', 'resto-a', 'owner-a');
    INSERT INTO onboarding_tokens (id, user_id, restaurant_id) VALUES ('token-a', 'admin-a', 'resto-a');
  `);
}

describe("multi-restaurant backfill checker", () => {
  test("passes a complete migrated backfill", () => {
    const db = createDb();
    seedValidBackfill(db);

    expect(collectMultiRestaurantBackfillFailures(db)).toEqual([]);
  });

  test("reports legal acceptance and onboarding token backfill gaps", () => {
    const db = createDb();
    seedValidBackfill(db);
    db.exec(`
      INSERT INTO legal_acceptances (id, restaurant_id, owner_id) VALUES ('legal-missing-owner', 'resto-a', NULL);
      INSERT INTO onboarding_tokens (id, user_id, restaurant_id) VALUES ('token-missing-restaurant', 'admin-a', NULL);
    `);

    const failures = collectMultiRestaurantBackfillFailures(db);
    expect(failures).toContain("legal_acceptances_without_owner: 1");
    expect(failures).toContain("onboarding_tokens_without_restaurant: 1");
  });

  test("reports membership and session context gaps", () => {
    const db = createDb();
    seedValidBackfill(db);
    db.exec(`
      INSERT INTO users (id, restaurant_id, active) VALUES ('worker-without-membership', 'resto-a', 1);
      INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES ('resto-a', 'worker-without-owner', 'floor', 1);
      INSERT INTO sessions (id, user_id, active_restaurant_id) VALUES ('session-missing-active-restaurant', 'admin-a', NULL);
    `);

    const failures = collectMultiRestaurantBackfillFailures(db);
    expect(failures).toContain("active_users_without_membership: 1");
    expect(failures).toContain("active_memberships_without_owner_membership: 1");
    expect(failures).toContain("sessions_without_active_restaurant: 1");
  });
});
