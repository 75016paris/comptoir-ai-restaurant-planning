import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createPhase7CoreSnapshot,
  PHASE7_CORE_SNAPSHOT_VERSION,
  verifyPhase7CoreSnapshot,
} from "./phase7-core-snapshot";

function createSourceDb() {
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
    CREATE TABLE restaurants (
      id text primary key,
      owner_id text,
      name text not null,
      address text,
      siret text,
      timezone text not null default 'Europe/Paris',
      status text not null default 'active',
      open_days text not null default '[2,3,4,5,6,7]',
      medical_mode integer not null default 0,
      tap_in_out_enabled integer not null default 0,
      tap_in_out_admin_confirmation integer not null default 0,
      tap_in_out_mode text not null default 'lateness_only',
      tap_in_counts_as_hours integer not null default 0,
      reminder_frequency text not null default 'off',
      color_scheme text not null default 'classic',
      kitchen_color text not null default 'amber',
      floor_color text not null default 'sky',
      worker_preferences_enabled integer not null default 1,
      auto_staffing_weeks integer not null default 3,
      disabled_compliance_rules text not null default '["HCR-L3121-16"]',
      kitchen_sub_roles text not null default '["Chef","Cuisinier"]',
      floor_sub_roles text not null default '["Chef de rang","Serveur"]',
      overtime_mode text not null default 'flexible',
      overtime_weekly_cap integer not null default 48,
      overtime_distribution text not null default 'willing-first',
      hcr_grid text not null default '{}',
      subrole_hcr_map text not null default '{}',
      default_contract_type text not null default 'CDI',
      default_contract_hours integer not null default 39,
      preferred_style text not null default 'equipe-stable',
      custom_weights text,
      latitude real,
      longitude real,
      cache_version integer not null default 0,
      onboarding_completed_at text,
      created_at text not null default (datetime('now'))
    );
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
    CREATE TABLE restaurant_memberships (restaurant_id text, user_id text, role text, permissions text, active integer, created_at text not null default (datetime('now')));
    CREATE TABLE worker_restaurant_profiles (
      restaurant_id text,
      user_id text,
      priority integer,
      sub_roles text,
      contract_type text,
      contract_hours integer,
      contract_end_date text,
      max_weekly_hours integer,
      admin_ot_override integer,
      hcr_level text,
      hourly_rate integer,
      matricule text,
      manager_notes text,
      multi_restaurant_willing integer
    );
    CREATE TABLE worker_share_authorizations (
      id text primary key,
      owner_id text,
      source_restaurant_id text,
      target_restaurant_id text,
      user_id text,
      role text,
      status text,
      invited_by_user_id text,
      worker_consented_at text,
      revoked_at text,
      created_at text,
      updated_at text
    );
    CREATE TABLE staffing_profiles (
      id text primary key,
      restaurant_id text,
      name text,
      sort_order integer,
      day_priorities text,
      preferred_assignments text,
      created_at text
    );
    CREATE TABLE service_templates (
      id text primary key,
      restaurant_id text,
      profile_id text,
      role text,
      zone text,
      start_time text,
      end_time text,
      sort_order integer
    );
    CREATE TABLE service_template_overrides (
      id text primary key,
      template_id text,
      day_of_week integer,
      start_time text,
      end_time text
    );
    CREATE TABLE staffing_schedule (
      id text primary key,
      restaurant_id text,
      profile_id text,
      year integer,
      week integer
    );
    CREATE TABLE staffing_targets (
      id text primary key,
      restaurant_id text,
      profile_id text,
      day_of_week integer,
      role text,
      zone text,
      count integer,
      role_breakdown text
    );
    CREATE TABLE staffing_analysis_cache (
      id text primary key,
      restaurant_id text,
      profile_id text,
      horizon_weeks integer,
      base_monday text,
      cache_key text,
      status text,
      started_at text,
      finished_at text,
      duration_ms integer,
      result text,
      error text
    );
    CREATE TABLE sub_role_training_costs (
      restaurant_id text,
      from_role text,
      to_role text,
      cost_points real,
      successes integer,
      failures integer,
      last_updated integer,
      admin_override integer
    );
    CREATE TABLE sub_role_training_moves (
      id text primary key,
      restaurant_id text,
      worker_id text,
      move_type text,
      from_role text,
      to_role text,
      applied_at integer,
      observed_at integer,
      outcome text
    );
    CREATE TABLE onboarding_tokens (
      id text primary key,
      user_id text,
      restaurant_id text,
      token text,
      created_at text,
      expires_at text
    );
    CREATE TABLE worker_weekly_hours (
      worker_id text,
      week_start text,
      hours_actual real,
      recorded_at integer,
      source text
    );
    CREATE TABLE sessions (id text primary key, user_id text, active_restaurant_id text, expires_at text, created_at text not null default (datetime('now')));
    CREATE TABLE services (
      id text primary key,
      worker_id text,
      restaurant_id text,
      date text,
      start_time text,
      end_time text,
      role text,
      status text,
      source text,
      filled_as text,
      notes text,
      created_at text,
      updated_at text
    );
    CREATE TABLE time_clocks (
      id text primary key,
      user_id text,
      restaurant_id text,
      service_id text,
      tap_in text,
      tap_out text,
      date text,
      admin_confirmed_at text,
      admin_confirmed_by text,
      created_at text
    );
    CREATE TABLE daily_revenue (
      id text primary key,
      restaurant_id text,
      date text,
      amount integer,
      notes text,
      created_at text
    );
    CREATE TABLE restaurant_closures (
      id text primary key,
      restaurant_id text,
      start_date text,
      end_date text,
      reason text,
      schedule text,
      created_at text
    );
    CREATE TABLE published_weeks (
      id text primary key,
      restaurant_id text,
      week_date text,
      published_at text
    );
    CREATE TABLE calendar_events (
      id text primary key,
      restaurant_id text,
      type text,
      date text,
      end_date text,
      name text,
      zone text,
      year integer,
      created_at text
    );
    CREATE TABLE worker_availability (
      id text primary key,
      worker_id text,
      restaurant_id text,
      day_of_week integer,
      midi integer,
      soir integer,
      midi_start text,
      midi_end text,
      soir_start text,
      soir_end text,
      continuous integer,
      zones text
    );
    CREATE TABLE worker_preferred_schedule (
      id text primary key,
      worker_id text,
      restaurant_id text,
      day_of_week integer,
      midi integer,
      soir integer,
      zones text
    );
    CREATE TABLE worker_restrictions (
      id text primary key,
      worker_id text,
      restaurant_id text,
      day_of_week integer,
      start_time text,
      end_time text,
      reason text,
      effective_from text,
      effective_until text,
      created_at text
    );
    CREATE TABLE email_recipients (
      id text primary key,
      restaurant_id text,
      label text,
      email text,
      send_monthly_digest integer,
      send_leave_alerts integer,
      created_at text
    );
    CREATE TABLE contract_templates (
      id text primary key,
      restaurant_id text,
      kind text,
      name text,
      body_html text,
      is_default integer,
      created_by text,
      created_at text,
      updated_at text
    );
    CREATE TABLE weather_data (
      id text primary key,
      restaurant_id text,
      date text,
      weather_code integer,
      temp_max real,
      temp_min real,
      sunrise text,
      sunset text,
      normal_temp_max real,
      normal_temp_min real,
      hourly_weather_codes text,
      hourly_temperatures text,
      is_forecast integer,
      fetched_at text
    );
    CREATE TABLE admin_alerts (
      id text primary key,
      restaurant_id text,
      recipient_id text,
      type text,
      title text,
      body text,
      action_url text,
      worker_id text,
      created_at text,
      seen_at text
    );
    CREATE TABLE holiday_requests (
      id text primary key,
      worker_id text,
      restaurant_id text,
      start_date text,
      end_date text,
      reason text,
      medical integer,
      status text,
      source text,
      reviewed_by text,
      reviewed_at text,
      created_at text
    );
    CREATE TABLE replacement_requests (
      id text primary key,
      requester_id text,
      requester_service_id text,
      target_id text,
      restaurant_id text,
      status text,
      message text,
      responded_at text,
      expires_at text,
      candidate_ids text,
      candidate_scores text,
      admin_notified_at text,
      worker_notified_at text,
      escalation_count integer,
      rejected_candidate_ids text,
      medical integer,
      itt_reminder_sent_at text,
      created_at text
    );
    CREATE TABLE open_shifts (
      id text primary key,
      restaurant_id text,
      created_by text,
      date text,
      start_time text,
      end_time text,
      role text,
      required_sub_roles text,
      message text,
      candidate_ids text,
      rejected_candidate_ids text,
      solicited_candidate_ids text,
      last_solicited_at text,
      status text,
      claimed_by text,
      claimed_at text,
      service_id text,
      expires_at text,
      created_at text
    );
    CREATE TABLE restriction_requests (
      id text primary key,
      worker_id text,
      restaurant_id text,
      kind text,
      effective_from text,
      effective_until text,
      restrictions text,
      status text,
      note text,
      admin_note text,
      reviewed_by text,
      reviewed_at text,
      created_at text
    );
    CREATE TABLE documents (
      id text primary key,
      user_id text,
      restaurant_id text,
      holiday_request_id text,
      replacement_request_id text,
      name text,
      type text,
      filename text,
      mime_type text,
      size integer,
      data text,
      storage_provider text,
      storage_key text,
      storage_status text,
      uploaded_by text,
      requirement_key text,
      issued_at text,
      expires_at text,
      signed_at text,
      reviewed_at text,
      reviewed_by text,
      created_at text
    );
    CREATE TABLE audit_logs (
      id text primary key,
      restaurant_id text,
      table_name text,
      row_id text,
      action text,
      actor_id text,
      actor_name text,
      source text,
      changes text,
      summary text,
      created_at text
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
  db.exec(`
    INSERT INTO owners (id, name, subscription_status) VALUES ('owner-a', 'Owner A', 'active'), ('owner-b', 'Owner B', 'active');
    INSERT INTO restaurants (id, owner_id, name) VALUES ('resto-a', 'owner-a', 'A'), ('resto-b', 'owner-b', 'B');
    INSERT INTO users (id, name, email, phone, password_hash) VALUES ('user-a', 'User A', 'a@example.test', '+331', 'hash-a'), ('user-b', 'User B', 'b@example.test', '+332', 'hash-b');
    INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'user-a', 'owner_admin'), ('owner-b', 'user-b', 'owner_admin');
    INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES ('resto-a', 'user-a', 'admin', 1), ('resto-b', 'user-b', 'admin', 1);
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, multi_restaurant_willing) VALUES ('resto-a', 'user-a', 1, '[]', 0);
    INSERT INTO worker_share_authorizations (id, owner_id, source_restaurant_id, target_restaurant_id, user_id, role, status, invited_by_user_id, created_at, updated_at) VALUES ('share-a', 'owner-a', 'resto-a', 'resto-a', 'user-a', 'floor', 'accepted', 'user-a', 'now', 'now');
    INSERT INTO staffing_profiles (id, restaurant_id, name, sort_order, day_priorities, preferred_assignments, created_at) VALUES ('profile-a', 'resto-a', 'Default', 0, '{}', '[]', 'now');
    INSERT INTO service_templates (id, restaurant_id, profile_id, role, zone, start_time, end_time, sort_order) VALUES ('template-a', 'resto-a', 'profile-a', 'floor', 'Soir', '18:00', '22:00', 0);
    INSERT INTO service_template_overrides (id, template_id, day_of_week, start_time, end_time) VALUES ('override-a', 'template-a', 5, '19:00', '23:00');
    INSERT INTO staffing_schedule (id, restaurant_id, profile_id, year, week) VALUES ('schedule-a', 'resto-a', 'profile-a', 2026, 22);
    INSERT INTO staffing_targets (id, restaurant_id, profile_id, day_of_week, role, zone, count, role_breakdown) VALUES ('target-a', 'resto-a', 'profile-a', 5, 'floor', 'Soir', 2, '{}');
    INSERT INTO staffing_analysis_cache (id, restaurant_id, profile_id, horizon_weeks, base_monday, cache_key, status, started_at) VALUES ('cache-a', 'resto-a', 'profile-a', 12, '2026-05-25', 'cache-key-a', 'ok', 'now');
    INSERT INTO sub_role_training_costs (restaurant_id, from_role, to_role, cost_points, successes, failures, last_updated, admin_override) VALUES ('resto-a', 'Serveur', 'Chef de rang', 1.5, 1, 0, 1710000000000, 0);
    INSERT INTO sub_role_training_moves (id, restaurant_id, worker_id, move_type, from_role, to_role, applied_at, observed_at, outcome) VALUES ('move-a', 'resto-a', 'user-a', 'intra_train', 'Serveur', 'Chef de rang', 1710000000000, 1710003600000, 'success');
    INSERT INTO onboarding_tokens (id, user_id, restaurant_id, token, created_at, expires_at) VALUES ('token-a', 'user-a', 'resto-a', 'token-value-a', 'now', '2099-01-01');
    INSERT INTO worker_weekly_hours (worker_id, week_start, hours_actual, recorded_at, source) VALUES ('user-a', '2026-05-25', 35.5, 1710000000000, 'services');
    INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES ('session-a', 'user-a', 'resto-a', '2099-01-01T00:00:00.000Z');
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source, created_at, updated_at) VALUES ('service-a', 'user-a', 'resto-a', '2026-05-25', '10:00', '14:00', 'floor', 'scheduled', 'manual', 'now', 'now');
    INSERT INTO time_clocks (id, user_id, restaurant_id, service_id, tap_in, date, created_at) VALUES ('tc-a', 'user-a', 'resto-a', 'service-a', '2026-05-25T10:00:00.000Z', '2026-05-25', 'now');
    INSERT INTO daily_revenue (id, restaurant_id, date, amount, notes, created_at) VALUES ('rev-a', 'resto-a', '2026-05-25', 12345, 'lunch', 'now');
    INSERT INTO restaurant_closures (id, restaurant_id, start_date, end_date, reason, schedule, created_at) VALUES ('close-a', 'resto-a', '2026-08-01', '2026-08-15', 'vacances', '{}', 'now');
    INSERT INTO published_weeks (id, restaurant_id, week_date, published_at) VALUES ('pub-a', 'resto-a', '2026-05-25', 'now');
    INSERT INTO calendar_events (id, restaurant_id, type, date, name, zone, year, created_at) VALUES ('cal-a', 'resto-a', 'public_holiday', '2026-05-25', 'Holiday', 'metropole', 2026, 'now');
    INSERT INTO worker_availability (id, worker_id, restaurant_id, day_of_week, midi, soir, continuous, zones) VALUES ('avail-a', 'user-a', 'resto-a', 1, 1, 0, 0, '{}');
    INSERT INTO worker_preferred_schedule (id, worker_id, restaurant_id, day_of_week, midi, soir, zones) VALUES ('pref-a', 'user-a', 'resto-a', 1, 1, 0, '{}');
    INSERT INTO worker_restrictions (id, worker_id, restaurant_id, day_of_week, start_time, end_time, reason, created_at) VALUES ('restrict-a', 'user-a', 'resto-a', 1, '10:00', '12:00', 'indispo', 'now');
    INSERT INTO email_recipients (id, restaurant_id, label, email, send_monthly_digest, send_leave_alerts, created_at) VALUES ('email-a', 'resto-a', 'Comptable', 'accounting@example.test', 1, 0, 'now');
    INSERT INTO contract_templates (id, restaurant_id, kind, name, body_html, is_default, created_by, created_at, updated_at) VALUES ('contract-a', 'resto-a', 'CDI', 'CDI', '<p>body</p>', 1, 'user-a', 'now', 'now');
    INSERT INTO weather_data (id, restaurant_id, date, weather_code, temp_max, temp_min, is_forecast, fetched_at) VALUES ('weather-a', 'resto-a', '2026-05-25', 1, 21, 12, 1, 'now');
    INSERT INTO admin_alerts (id, restaurant_id, recipient_id, type, title, body, worker_id, created_at) VALUES ('alert-a', 'resto-a', 'user-a', 'test', 'Title', 'Body', 'user-a', 'now');
    INSERT INTO holiday_requests (id, worker_id, restaurant_id, start_date, end_date, reason, medical, status, source, reviewed_by, created_at) VALUES ('holiday-a', 'user-a', 'resto-a', '2026-08-01', '2026-08-02', 'repos', 0, 'pending', 'worker', 'user-a', 'now');
    INSERT INTO replacement_requests (id, requester_id, requester_service_id, target_id, restaurant_id, status, expires_at, candidate_ids, candidate_scores, escalation_count, rejected_candidate_ids, medical, created_at) VALUES ('replacement-a', 'user-a', 'service-a', 'user-a', 'resto-a', 'awaiting_admin_decision', '2099-01-01', '["user-a"]', '{"user-a":1}', 0, '[]', 0, 'now');
    INSERT INTO open_shifts (id, restaurant_id, created_by, date, start_time, end_time, role, required_sub_roles, candidate_ids, rejected_candidate_ids, solicited_candidate_ids, status, claimed_by, service_id, expires_at, created_at) VALUES ('open-a', 'resto-a', 'user-a', '2026-05-26', '18:00', '22:00', 'floor', '[]', '["user-a"]', '[]', '["user-a"]', 'claimed', 'user-a', 'service-a', '2099-01-01', 'now');
    INSERT INTO restriction_requests (id, worker_id, restaurant_id, kind, effective_from, effective_until, restrictions, status, note, admin_note, reviewed_by, reviewed_at, created_at) VALUES ('restriction-request-a', 'user-a', 'resto-a', 'temporary', '2026-06-01', '2026-06-07', '[]', 'approved', 'besoin', 'ok', 'user-a', 'now', 'now');
    INSERT INTO documents (id, user_id, restaurant_id, name, type, filename, mime_type, size, data, storage_status, uploaded_by, created_at) VALUES ('doc-a', 'user-a', 'resto-a', 'Doc', 'id', 'doc.pdf', 'application/pdf', 1, '', 'ready', 'user-a', 'now');
    INSERT INTO audit_logs (id, restaurant_id, table_name, row_id, action, source, created_at) VALUES ('audit-a', 'resto-a', 'services', 'service-a', 'insert', 'test', 'now');
    INSERT INTO legal_acceptances (id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version, accepted_at, created_at) VALUES ('legal-a', 'owner-a', 'resto-a', 'user-a', 'owner_terms', 'terms-v1', 'dpa-v1', 'privacy-v1', 'subprocessors-v1', 'now', 'now');
    INSERT INTO notifications (id, recipient_id, owner_id, restaurant_id, type, channel, message, status, scheduled_for, created_at) VALUES
      ('notif-master', 'user-a', 'owner-a', NULL, 'payment_failed', 'whatsapp', 'Payment failed', 'queued', 'now', 'now'),
      ('notif-owner', 'user-a', 'owner-a', 'resto-a', 'schedule_change', 'whatsapp', 'Schedule changed', 'queued', 'now', 'now');
    INSERT INTO chat_messages (id, user_id, owner_id, restaurant_id, context_kind, role, content, created_at) VALUES
      ('chat-master', 'user-a', NULL, NULL, 'pre_context', 'user', 'Bonjour', 'now'),
      ('chat-owner', 'user-a', 'owner-a', 'resto-a', 'restaurant_context', 'assistant', 'Planning', 'now');
    INSERT INTO cron_runs (id, job_name, owner_id, scope, attempt, status, started_at) VALUES
      (1, 'fleet-job', NULL, 'fleet', 1, 'ok', 'now'),
      (2, 'owner-job', 'owner-a', 'owner', 1, 'ok', 'now');
  `);
  return db;
}

function count(filePath: string, table: string) {
  const db = new Database(filePath, { readonly: true });
  try {
    return Number((db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
  } finally {
    db.close();
  }
}

describe("Phase 7 core snapshot", () => {
  test("copies core master and owner rows into isolated databases", () => {
    const source = createSourceDb();
    const directory = mkdtempSync(join(tmpdir(), "comptoir-phase7-core-"));
    const out = join(directory, "snapshot");

    const result = createPhase7CoreSnapshot({ source, directory: out });

    expect(verifyPhase7CoreSnapshot(result)).toEqual([]);
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.snapshotVersion).toBe(PHASE7_CORE_SNAPSHOT_VERSION);
    expect(manifest.scope).toEqual(expect.objectContaining({
      kind: "core",
      copiedOwnerTables: [
        "admin_alerts",
        "audit_logs",
        "calendar_events",
        "contract_templates",
        "daily_revenue",
        "documents",
        "email_recipients",
        "holiday_requests",
        "onboarding_tokens",
        "open_shifts",
        "published_weeks",
        "replacement_requests",
        "restaurant_closures",
        "restaurant_memberships",
        "restaurants",
        "restriction_requests",
        "service_template_overrides",
        "service_templates",
        "services",
        "staffing_analysis_cache",
        "staffing_profiles",
        "staffing_schedule",
        "staffing_targets",
        "sub_role_training_costs",
        "sub_role_training_moves",
        "time_clocks",
        "users",
        "weather_data",
        "worker_availability",
        "worker_preferred_schedule",
        "worker_restaurant_profiles",
        "worker_restrictions",
        "worker_share_authorizations",
        "worker_weekly_hours",
      ],
    }));
    expect(manifest.scope.remainingSplitTables).not.toContain("notifications");
    expect(manifest.scope.remainingSplitTables).not.toContain("chat_messages");
    expect(manifest.scope.remainingSplitTables).not.toContain("cron_runs");
    expect(manifest.scope.remainingSplitTables).not.toContain("users");
    expect(manifest.scope.remainingSplitTables).not.toContain("legal_acceptances");
    expect(manifest.fileFingerprints[result.masterPath].sha256).toHaveLength(64);
    expect(count(result.masterPath, "login_identities")).toBe(2);
    expect(count(result.masterPath, "owners")).toBe(2);
    expect(count(result.masterPath, "owner_legal_acceptances")).toBe(1);
    expect(count(result.masterPath, "sessions")).toBe(1);
    expect(count(result.masterPath, "notifications")).toBe(1);
    expect(count(result.masterPath, "chat_messages")).toBe(1);
    expect(count(result.masterPath, "cron_runs")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "restaurants")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "users")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "worker_share_authorizations")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "staffing_profiles")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "service_templates")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "service_template_overrides")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "staffing_schedule")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "staffing_targets")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "staffing_analysis_cache")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "sub_role_training_costs")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "sub_role_training_moves")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "onboarding_tokens")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "worker_weekly_hours")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "services")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "time_clocks")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "daily_revenue")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "restaurant_closures")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "published_weeks")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "calendar_events")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "worker_availability")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "worker_preferred_schedule")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "worker_restrictions")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "email_recipients")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "contract_templates")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "weather_data")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "admin_alerts")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "holiday_requests")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "replacement_requests")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "open_shifts")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "restriction_requests")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "documents")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "notifications")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "chat_messages")).toBe(1);
    expect(count(result.ownerPaths["owner-a"], "cron_runs")).toBe(1);
    expect(count(result.ownerPaths["owner-b"], "services")).toBe(0);
    expect(count(result.ownerPaths["owner-b"], "notifications")).toBe(0);
  });

  test("refuses to write into an existing output directory", () => {
    const source = createSourceDb();
    const directory = mkdtempSync(join(tmpdir(), "comptoir-phase7-existing-"));

    expect(() => createPhase7CoreSnapshot({ source, directory })).toThrow("already exists");
  });
});
