import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const apiRoot = join(import.meta.dir, "../..");

function readBaseline(path: string) {
  return readFileSync(join(apiRoot, "drizzle/phase7", path), "utf8");
}

function tableNames(db: Database) {
  return db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: Database, table: string) {
  return db.query(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("Phase 7 SQL baselines", () => {
  test("master baseline creates the control-plane tables", () => {
    const db = new Database(":memory:");
    db.exec(readBaseline("master/0000_master_baseline.sql"));

    expect(tableNames(db)).toEqual([
      "chat_messages",
      "cron_runs",
      "login_identities",
      "notifications",
      "owner_legal_acceptances",
      "owner_memberships",
      "owners",
      "password_reset_tokens",
      "pending_registrations",
      "phone_routes",
      "sessions",
      "whatsapp_context_sessions",
    ]);
    expect(columnNames(db, "owners")).toContain("database_path");
    expect(columnNames(db, "sessions")).toEqual(expect.arrayContaining([
      "active_owner_id",
      "active_restaurant_id",
    ]));
  });

  test("owner baseline creates operational tables without login secrets", () => {
    const db = new Database(":memory:");
    db.exec(readBaseline("owner/0000_owner_baseline.sql"));

    expect(tableNames(db)).toEqual(expect.arrayContaining([
      "restaurants",
      "users",
      "restaurant_memberships",
      "worker_restaurant_profiles",
      "services",
      "documents",
      "time_clocks",
      "audit_logs",
      "cron_runs",
    ]));
    expect(columnNames(db, "users")).toEqual([
      "id",
      "display_name",
      "first_name",
      "last_name",
      "phone",
      "active",
      "created_at",
    ]);
    expect(tableNames(db)).not.toContain("password_reset_tokens");
    expect(tableNames(db)).not.toContain("sessions");
  });
});
