import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runPhase7ReadinessPreflight } from "./phase7-readiness-preflight";

function createEmptyReadySourceDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE owners (
      id text primary key,
      name text not null,
      stripe_customer_id text,
      stripe_subscription_id text,
      subscription_status text not null default 'active',
      subscription_period_end text,
      trial_ends_at text,
      cancel_at text,
      created_at text not null default (datetime('now'))
    );
    CREATE TABLE restaurants (id text primary key, owner_id text);
    CREATE TABLE users (
      id text primary key,
      name text not null,
      first_name text,
      last_name text,
      email text not null,
      phone text not null,
      password_hash text not null,
      active integer not null default 1,
      must_change_password integer not null default 0,
      user_notice_version text,
      user_notice_accepted_at text,
      user_notice_ip_address text,
      user_notice_user_agent text,
      whatsapp_opt_in integer not null default 0,
      whatsapp_opt_in_at text,
      whatsapp_opt_out_at text,
      created_at text not null default (datetime('now'))
    );
    CREATE TABLE owner_memberships (owner_id text, user_id text, role text, created_at text not null default (datetime('now')));
    CREATE TABLE restaurant_memberships (restaurant_id text, user_id text);
    CREATE TABLE worker_restaurant_profiles (restaurant_id text, user_id text);
    CREATE TABLE worker_share_authorizations (id text primary key, owner_id text, source_restaurant_id text, target_restaurant_id text);
    CREATE TABLE staffing_profiles (id text primary key, restaurant_id text);
    CREATE TABLE service_templates (id text primary key, restaurant_id text);
    CREATE TABLE service_template_overrides (id text primary key, template_id text);
    CREATE TABLE staffing_schedule (id text primary key, restaurant_id text);
    CREATE TABLE staffing_targets (id text primary key, restaurant_id text);
    CREATE TABLE sub_role_training_costs (restaurant_id text);
    CREATE TABLE sub_role_training_moves (id text primary key, restaurant_id text);
    CREATE TABLE onboarding_tokens (id text primary key, user_id text, restaurant_id text);
    CREATE TABLE worker_weekly_hours (worker_id text, week_start text);
    CREATE TABLE services (id text primary key, restaurant_id text);
    CREATE TABLE time_clocks (id text primary key, restaurant_id text);
    CREATE TABLE daily_revenue (id text primary key, restaurant_id text);
    CREATE TABLE restaurant_closures (id text primary key, restaurant_id text);
    CREATE TABLE published_weeks (id text primary key, restaurant_id text);
    CREATE TABLE calendar_events (id text primary key, restaurant_id text);
    CREATE TABLE worker_availability (id text primary key, restaurant_id text);
    CREATE TABLE worker_preferred_schedule (id text primary key, restaurant_id text);
    CREATE TABLE worker_restrictions (id text primary key, restaurant_id text);
    CREATE TABLE email_recipients (id text primary key, restaurant_id text);
    CREATE TABLE contract_templates (id text primary key, restaurant_id text);
    CREATE TABLE weather_data (id text primary key, restaurant_id text);
    CREATE TABLE admin_alerts (id text primary key, restaurant_id text);
    CREATE TABLE holiday_requests (id text primary key, restaurant_id text);
    CREATE TABLE replacement_requests (id text primary key, restaurant_id text);
    CREATE TABLE open_shifts (id text primary key, restaurant_id text);
    CREATE TABLE restriction_requests (id text primary key, restaurant_id text);
    CREATE TABLE documents (id text primary key, restaurant_id text, user_id text, storage_provider text, storage_key text);
    CREATE TABLE audit_logs (id text primary key, restaurant_id text);
    CREATE TABLE sessions (
      id text primary key,
      user_id text,
      active_restaurant_id text,
      expires_at text,
      created_at text not null default (datetime('now'))
    );
    CREATE TABLE legal_acceptances (
      id text primary key,
      owner_id text,
      restaurant_id text,
      user_id text,
      acceptance_type text,
      terms_version text,
      dpa_version text,
      privacy_version text,
      subprocessors_version text,
      ip_address text,
      user_agent text,
      accepted_at text,
      created_at text
    );
    CREATE TABLE notifications (
      id text primary key,
      recipient_id text,
      owner_id text,
      restaurant_id text,
      type text,
      channel text,
      message text,
      status text,
      scheduled_for text,
      sent_at text,
      created_at text
    );
    CREATE TABLE chat_messages (
      id text primary key,
      user_id text,
      owner_id text,
      restaurant_id text,
      context_kind text,
      role text,
      content text,
      tool_calls text,
      created_at text
    );
    CREATE TABLE cron_runs (
      id integer primary key,
      job_name text,
      owner_id text,
      scope text,
      attempt integer,
      status text,
      started_at text,
      finished_at text,
      duration_ms integer,
      error text,
      result text
    );
  `);
  return db;
}

describe("Phase 7 readiness preflight", () => {
  test("passes when dry-run, snapshot, report, and document plan checks are clean", () => {
    const source = createEmptyReadySourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-preflight-")), "snapshot");

    const result = runPhase7ReadinessPreflight({
      source,
      directory,
      generatedAt: "2026-05-25T20:00:00.000Z",
    });

    expect(result).toEqual({
      reportVersion: 2,
      generatedAt: "2026-05-25T20:00:00.000Z",
      status: "pass",
      directory,
      dryRunFailures: [],
      splitSchemaIssues: 0,
      splitScopeGaps: 0,
      snapshotVerificationFailures: [],
      snapshotReportStatus: "pass",
      documentMoveCount: 0,
      documentIssueCount: 0,
      documentPlanIssueCount: 0,
      snapshotSummary: {
        ownerDatabases: 0,
        restaurants: 0,
        users: 0,
        services: 0,
        documents: 0,
        notifications: 0,
        chatMessages: 0,
        cronRuns: 0,
        totalDatabaseBytes: expect.any(Number),
      },
      failures: [],
    });
  });

  test("returns a failing report instead of creating a snapshot when split scope columns are missing", () => {
    const source = createEmptyReadySourceDb();
    source.exec(`
      DROP TABLE notifications;
      CREATE TABLE notifications (id text primary key);
    `);
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-preflight-fail-")), "snapshot");

    const result = runPhase7ReadinessPreflight({
      source,
      directory,
      generatedAt: "2026-05-25T20:01:00.000Z",
    });

    expect(result.reportVersion).toBe(2);
    expect(result.generatedAt).toBe("2026-05-25T20:01:00.000Z");
    expect(result.status).toBe("fail");
    expect(result.splitSchemaIssues).toBe(1);
    expect(result.snapshotReportStatus).toBe("fail");
    expect(result.snapshotSummary).toBe(null);
    expect(result.failures).toContain("split_schema:notifications:owner_id,restaurant_id");
    expect(result.failures).not.toContain("snapshot_report:status_fail");
  });
});
