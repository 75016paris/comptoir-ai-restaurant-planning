import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createPhase7CoreSnapshot, PHASE7_CORE_SNAPSHOT_MANIFEST } from "./phase7-core-snapshot";
import { verifyPhase7CoreSnapshotDirectory } from "./phase7-core-snapshot-verifier";

function createSourceDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE owners (id text primary key, name text not null, stripe_customer_id text, stripe_subscription_id text, subscription_status text not null default 'active', subscription_period_end text, trial_ends_at text, cancel_at text, created_at text not null default (datetime('now')));
    CREATE TABLE restaurants (id text primary key, owner_id text, name text not null, address text, siret text, timezone text not null default 'Europe/Paris', status text not null default 'active', open_days text not null default '[2,3,4,5,6,7]', medical_mode integer not null default 0, tap_in_out_enabled integer not null default 0, tap_in_out_admin_confirmation integer not null default 0, tap_in_out_mode text not null default 'lateness_only', tap_in_counts_as_hours integer not null default 0, reminder_frequency text not null default 'off', color_scheme text not null default 'classic', kitchen_color text not null default 'amber', floor_color text not null default 'sky', worker_preferences_enabled integer not null default 1, auto_staffing_weeks integer not null default 3, disabled_compliance_rules text not null default '["HCR-L3121-16"]', kitchen_sub_roles text not null default '["Chef","Cuisinier"]', floor_sub_roles text not null default '["Chef de rang","Serveur"]', overtime_mode text not null default 'flexible', overtime_weekly_cap integer not null default 48, overtime_distribution text not null default 'willing-first', hcr_grid text not null default '{}', subrole_hcr_map text not null default '{}', default_contract_type text not null default 'CDI', default_contract_hours integer not null default 39, preferred_style text not null default 'equipe-stable', custom_weights text, latitude real, longitude real, cache_version integer not null default 0, onboarding_completed_at text, created_at text not null default (datetime('now')));
    CREATE TABLE users (id text primary key, name text not null, first_name text, last_name text, email text not null, phone text not null, password_hash text not null, active integer not null default 1, must_change_password integer not null default 0, user_notice_version text, user_notice_accepted_at text, user_notice_ip_address text, user_notice_user_agent text, whatsapp_opt_in integer not null default 0, whatsapp_opt_in_at text, whatsapp_opt_out_at text, created_at text not null default (datetime('now')));
    CREATE TABLE owner_memberships (owner_id text, user_id text, role text, created_at text not null default (datetime('now')));
    CREATE TABLE restaurant_memberships (restaurant_id text, user_id text, role text, permissions text, active integer, created_at text not null default (datetime('now')));
    CREATE TABLE worker_restaurant_profiles (restaurant_id text, user_id text, priority integer, sub_roles text, contract_type text, contract_hours integer, contract_end_date text, max_weekly_hours integer, admin_ot_override integer, hcr_level text, hourly_rate integer, matricule text, manager_notes text, multi_restaurant_willing integer);
    CREATE TABLE worker_share_authorizations (id text primary key, owner_id text, source_restaurant_id text, target_restaurant_id text, user_id text, role text, status text, invited_by_user_id text, worker_consented_at text, revoked_at text, created_at text, updated_at text);
    CREATE TABLE staffing_profiles (id text primary key, restaurant_id text, name text, sort_order integer, day_priorities text, preferred_assignments text, created_at text);
    CREATE TABLE service_templates (id text primary key, restaurant_id text, profile_id text, role text, zone text, start_time text, end_time text, sort_order integer);
    CREATE TABLE service_template_overrides (id text primary key, template_id text, day_of_week integer, start_time text, end_time text);
    CREATE TABLE staffing_schedule (id text primary key, restaurant_id text, profile_id text, year integer, week integer);
    CREATE TABLE staffing_targets (id text primary key, restaurant_id text, profile_id text, day_of_week integer, role text, zone text, count integer, role_breakdown text);
    CREATE TABLE staffing_analysis_cache (id text primary key, restaurant_id text, profile_id text, horizon_weeks integer, base_monday text, cache_key text, status text, started_at text, finished_at text, duration_ms integer, result text, error text);
    CREATE TABLE sub_role_training_costs (restaurant_id text, from_role text, to_role text, cost_points real, successes integer, failures integer, last_updated integer, admin_override integer);
    CREATE TABLE sub_role_training_moves (id text primary key, restaurant_id text, worker_id text, move_type text, from_role text, to_role text, applied_at integer, observed_at integer, outcome text);
    CREATE TABLE onboarding_tokens (id text primary key, user_id text, restaurant_id text, token text, created_at text, expires_at text);
    CREATE TABLE worker_weekly_hours (worker_id text, week_start text, hours_actual real, recorded_at integer, source text);
    CREATE TABLE sessions (id text primary key, user_id text, active_restaurant_id text, expires_at text, created_at text not null default (datetime('now')));
    CREATE TABLE services (id text primary key, worker_id text, restaurant_id text, date text, start_time text, end_time text, role text, status text, source text, filled_as text, notes text, created_at text, updated_at text);
    CREATE TABLE time_clocks (id text primary key, user_id text, restaurant_id text, service_id text, tap_in text, tap_out text, date text, admin_confirmed_at text, admin_confirmed_by text, created_at text);
    CREATE TABLE daily_revenue (id text primary key, restaurant_id text, date text, amount integer, notes text, created_at text);
    CREATE TABLE restaurant_closures (id text primary key, restaurant_id text, start_date text, end_date text, reason text, schedule text, created_at text);
    CREATE TABLE published_weeks (id text primary key, restaurant_id text, week_date text, published_at text);
    CREATE TABLE calendar_events (id text primary key, restaurant_id text, type text, date text, end_date text, name text, zone text, year integer, created_at text);
    CREATE TABLE worker_availability (id text primary key, worker_id text, restaurant_id text, day_of_week integer, midi integer, soir integer, midi_start text, midi_end text, soir_start text, soir_end text, continuous integer, zones text);
    CREATE TABLE worker_preferred_schedule (id text primary key, worker_id text, restaurant_id text, day_of_week integer, midi integer, soir integer, zones text);
    CREATE TABLE worker_restrictions (id text primary key, worker_id text, restaurant_id text, day_of_week integer, start_time text, end_time text, reason text, effective_from text, effective_until text, created_at text);
    CREATE TABLE email_recipients (id text primary key, restaurant_id text, label text, email text, send_monthly_digest integer, send_leave_alerts integer, created_at text);
    CREATE TABLE contract_templates (id text primary key, restaurant_id text, kind text, name text, body_html text, is_default integer, created_by text, created_at text, updated_at text);
    CREATE TABLE weather_data (id text primary key, restaurant_id text, date text, weather_code integer, temp_max real, temp_min real, sunrise text, sunset text, normal_temp_max real, normal_temp_min real, hourly_weather_codes text, hourly_temperatures text, is_forecast integer, fetched_at text);
    CREATE TABLE admin_alerts (id text primary key, restaurant_id text, recipient_id text, type text, title text, body text, action_url text, worker_id text, created_at text, seen_at text);
    CREATE TABLE holiday_requests (id text primary key, worker_id text, restaurant_id text, start_date text, end_date text, reason text, medical integer, status text, source text, reviewed_by text, reviewed_at text, created_at text);
    CREATE TABLE replacement_requests (id text primary key, requester_id text, requester_service_id text, target_id text, restaurant_id text, status text, message text, responded_at text, expires_at text, candidate_ids text, candidate_scores text, admin_notified_at text, worker_notified_at text, escalation_count integer, rejected_candidate_ids text, medical integer, itt_reminder_sent_at text, created_at text);
    CREATE TABLE open_shifts (id text primary key, restaurant_id text, created_by text, date text, start_time text, end_time text, role text, required_sub_roles text, message text, candidate_ids text, rejected_candidate_ids text, solicited_candidate_ids text, last_solicited_at text, status text, claimed_by text, claimed_at text, service_id text, expires_at text, created_at text);
    CREATE TABLE restriction_requests (id text primary key, worker_id text, restaurant_id text, kind text, effective_from text, effective_until text, restrictions text, status text, note text, admin_note text, reviewed_by text, reviewed_at text, created_at text);
    CREATE TABLE documents (id text primary key, user_id text, restaurant_id text, holiday_request_id text, replacement_request_id text, name text, type text, filename text, mime_type text, size integer, data text, storage_provider text, storage_key text, storage_status text, uploaded_by text, requirement_key text, issued_at text, expires_at text, signed_at text, reviewed_at text, reviewed_by text, created_at text);
    CREATE TABLE audit_logs (id text primary key, restaurant_id text, table_name text, row_id text, action text, actor_id text, actor_name text, source text, changes text, summary text, created_at text);
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
    CREATE TABLE notifications (id text primary key, recipient_id text, owner_id text, restaurant_id text, type text, channel text, message text, status text, scheduled_for text, sent_at text, created_at text);
    CREATE TABLE chat_messages (id text primary key, user_id text, owner_id text, restaurant_id text, context_kind text, role text, content text, tool_calls text, created_at text);
    CREATE TABLE cron_runs (id integer primary key, job_name text, owner_id text, scope text, attempt integer, status text, started_at text, finished_at text, duration_ms integer, error text, result text);
  `);
  db.exec(`
    INSERT INTO owners (id, name) VALUES ('owner-a', 'Owner A');
    INSERT INTO restaurants (id, owner_id, name) VALUES ('resto-a', 'owner-a', 'A');
    INSERT INTO users (id, name, email, phone, password_hash) VALUES ('user-a', 'User A', 'a@example.test', '+331', 'hash-a');
    INSERT INTO owner_memberships (owner_id, user_id, role) VALUES ('owner-a', 'user-a', 'owner_admin');
    INSERT INTO restaurant_memberships (restaurant_id, user_id, role, active) VALUES ('resto-a', 'user-a', 'admin', 1);
    INSERT INTO worker_restaurant_profiles (restaurant_id, user_id, priority, sub_roles, multi_restaurant_willing) VALUES ('resto-a', 'user-a', 1, '[]', 0);
    INSERT INTO sessions (id, user_id, active_restaurant_id, expires_at) VALUES ('session-a', 'user-a', 'resto-a', '2099-01-01');
    INSERT INTO legal_acceptances (id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version, accepted_at, created_at) VALUES ('legal-a', 'owner-a', 'resto-a', 'user-a', 'owner_terms', 'terms-v1', 'dpa-v1', 'privacy-v1', 'subprocessors-v1', 'now', 'now');
    INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source, created_at, updated_at) VALUES ('service-a', 'user-a', 'resto-a', '2026-05-25', '10:00', '14:00', 'floor', 'scheduled', 'manual', 'now', 'now');
    INSERT INTO notifications (id, recipient_id, owner_id, restaurant_id, type, channel, message, status, scheduled_for, created_at) VALUES ('notif-a', 'user-a', 'owner-a', 'resto-a', 'schedule_change', 'whatsapp', 'Planning', 'queued', 'now', 'now');
    INSERT INTO chat_messages (id, user_id, owner_id, restaurant_id, context_kind, role, content, created_at) VALUES ('chat-a', 'user-a', 'owner-a', 'resto-a', 'restaurant_context', 'assistant', 'Planning', 'now');
    INSERT INTO cron_runs (id, job_name, owner_id, scope, attempt, status, started_at) VALUES (1, 'owner-job', 'owner-a', 'owner', 1, 'ok', 'now');
  `);
  return db;
}

describe("Phase 7 core snapshot verifier", () => {
  test("passes a freshly extracted core snapshot", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-verify-")), "snapshot");

    createPhase7CoreSnapshot({ source, directory });

    const result = verifyPhase7CoreSnapshotDirectory(directory);
    expect(result.failures).toEqual([]);
    expect(result.checkedOwners).toEqual([
      expect.objectContaining({
        ownerId: "owner-a",
        restaurants: 1,
        users: 1,
        services: 1,
      }),
    ]);
  });

  test("detects dangling owner-local rows", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-verify-bad-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec("INSERT INTO services (id, worker_id, restaurant_id, date, start_time, end_time, role, status, source) VALUES ('bad-service', 'missing-user', 'missing-resto', '2026-05-25', '10:00', '11:00', 'floor', 'scheduled', 'manual')");
    db.close();

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toEqual([
      `fingerprint mismatch for ${ownerFile}`,
      "owner-a: services rows without local restaurant: 1",
      "owner-a: services.worker_id rows without local user: 1",
      "owner-a: services count mismatch: 2 != 1",
    ]);
  });

  test("requires the manifest file", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-no-manifest-")), "snapshot");

    createPhase7CoreSnapshot({ source, directory });
    unlinkSync(join(directory, PHASE7_CORE_SNAPSHOT_MANIFEST));

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toEqual([
      `missing manifest file ${join(directory, PHASE7_CORE_SNAPSHOT_MANIFEST)}`,
    ]);
  });

  test("detects manifest copied counts that do not match the database files", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-bad-manifest-")), "snapshot");

    createPhase7CoreSnapshot({ source, directory });
    const manifestPath = join(directory, PHASE7_CORE_SNAPSHOT_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.copied.master.loginIdentities = 99;
    manifest.copied.owners[0].services = 99;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toContain("master: loginIdentities count mismatch: 1 != 99");
    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toContain("owner-a: services count mismatch: 1 != 99");
  });

  test("detects manifest scope table coverage that does not match the current core snapshot contract", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-bad-scope-")), "snapshot");

    createPhase7CoreSnapshot({ source, directory });
    const manifestPath = join(directory, PHASE7_CORE_SNAPSHOT_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scope.copiedOwnerTables = manifest.scope.copiedOwnerTables.filter((table: string) => table !== "services");
    manifest.scope.remainingSplitTables = [...manifest.scope.remainingSplitTables, "not_a_real_split_table"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("manifest: scope.copiedOwnerTables mismatch; missing [services], extra []");
    expect(failures).toContain("manifest: scope.remainingSplitTables mismatch; missing [], extra [not_a_real_split_table]");
  });

  test("detects master login identities that cannot route to an owner", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-ownerless-login-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const master = new Database(snapshot.masterPath);
    master.exec(`
      INSERT INTO login_identities (
        id,
        display_name,
        email,
        phone,
        password_hash,
        active,
        must_change_password,
        whatsapp_opt_in,
        created_at
      )
      VALUES ('user-ownerless', 'Ownerless', 'ownerless@example.test', '+339', 'hash', 1, 0, 0, 'now')
    `);
    master.close();

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toContain(
      "master: login identities without owner membership: 1",
    );
  });

  test("detects master owner legal acceptances pointing outside master identities", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-legal-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const master = new Database(snapshot.masterPath);
    master.exec(`
      INSERT INTO owner_legal_acceptances (
        id,
        owner_id,
        user_id,
        acceptance_type,
        terms_version,
        dpa_version,
        privacy_version,
        subprocessors_version,
        accepted_at,
        created_at
      )
      VALUES ('legal-dangling', 'missing-owner', 'missing-user', 'owner_terms', 'terms-v1', 'dpa-v1', 'privacy-v1', 'subprocessors-v1', 'now', 'now')
    `);
    master.close();

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toContain(
      "master: dangling owner legal acceptances: 1",
    );
  });

  test("detects owner-local users that do not match master owner memberships", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-user-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec("INSERT INTO users (id, display_name, phone, active, created_at) VALUES ('user-extra', 'Extra', '+339', 1, 'now')");
    db.close();

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toContain(
      "owner-a: owner-local users do not match master owner_memberships; missing [], extra [user-extra]",
    );
  });

  test("detects master sessions pointing at missing owner-local restaurants", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-session-context-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const master = new Database(snapshot.masterPath);
    master.exec("UPDATE sessions SET active_restaurant_id = 'missing-resto' WHERE id = 'session-a'");
    master.close();

    expect(verifyPhase7CoreSnapshotDirectory(directory).failures).toContain(
      "master: session session-a active restaurant missing-resto is missing from owner owner-a",
    );
  });

  test("detects document reviewer and uploader references outside the owner-local users", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-document-user-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO documents (
        id,
        user_id,
        restaurant_id,
        name,
        type,
        filename,
        mime_type,
        size,
        uploaded_by,
        reviewed_by,
        created_at
      )
      VALUES (
        'doc-bad',
        'user-a',
        'resto-a',
        'Doc',
        'id',
        'doc.pdf',
        'application/pdf',
        1,
        'missing-uploader',
        'missing-reviewer',
        'now'
      )
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: documents.uploaded_by rows without local user: 1");
    expect(failures).toContain("owner-a: documents.reviewed_by rows without local user: 1");
  });

  test("detects time clock user and service references outside the owner-local data", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-time-clock-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO time_clocks (
        id,
        user_id,
        restaurant_id,
        service_id,
        tap_in,
        date,
        admin_confirmed_by,
        created_at
      )
      VALUES (
        'tc-bad',
        'missing-worker',
        'resto-a',
        'missing-service',
        '2026-05-25T10:00:00.000Z',
        '2026-05-25',
        'missing-admin',
        'now'
      )
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: time_clocks.user_id rows without local user: 1");
    expect(failures).toContain("owner-a: time_clocks.admin_confirmed_by rows without local user: 1");
    expect(failures).toContain("owner-a: time_clocks.service_id rows without local service: 1");
  });

  test("detects open shift user, service, and JSON candidate references outside the owner-local data", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-open-shift-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO open_shifts (
        id,
        restaurant_id,
        created_by,
        date,
        start_time,
        end_time,
        role,
        candidate_ids,
        rejected_candidate_ids,
        solicited_candidate_ids,
        status,
        claimed_by,
        service_id,
        expires_at,
        created_at
      )
      VALUES (
        'open-bad',
        'resto-a',
        'missing-creator',
        '2026-05-25',
        '10:00',
        '14:00',
        'floor',
        '["missing-candidate"]',
        '["missing-rejected"]',
        '["missing-solicited"]',
        'claimed',
        'missing-claimant',
        'missing-service',
        '2099-01-01',
        'now'
      )
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: open_shifts.created_by rows without local user: 1");
    expect(failures).toContain("owner-a: open_shifts.claimed_by rows without local user: 1");
    expect(failures).toContain("owner-a: open_shifts.service_id rows without local service: 1");
    expect(failures).toContain("owner-a: open_shifts.candidate_ids JSON user ids without local user: 1");
    expect(failures).toContain("owner-a: open_shifts.rejected_candidate_ids JSON user ids without local user: 1");
    expect(failures).toContain("owner-a: open_shifts.solicited_candidate_ids JSON user ids without local user: 1");
  });

  test("detects restriction request worker and reviewer references outside the owner-local users", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-restriction-request-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO restriction_requests (
        id,
        worker_id,
        restaurant_id,
        kind,
        restrictions,
        status,
        reviewed_by,
        created_at
      )
      VALUES (
        'restriction-request-bad',
        'missing-worker',
        'resto-a',
        'temporary',
        '[]',
        'approved',
        'missing-reviewer',
        'now'
      )
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: restriction_requests.worker_id rows without local user: 1");
    expect(failures).toContain("owner-a: restriction_requests.reviewed_by rows without local user: 1");
  });

  test("detects worker share restaurants and users outside the owner-local data", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-worker-share-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO worker_share_authorizations (
        id,
        source_restaurant_id,
        target_restaurant_id,
        user_id,
        role,
        status,
        invited_by_user_id,
        created_at,
        updated_at
      )
      VALUES (
        'share-bad',
        'missing-source',
        'missing-target',
        'missing-worker',
        'floor',
        'pending',
        'missing-inviter',
        'now',
        'now'
      )
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: worker_share_authorizations.source_restaurant_id rows without local restaurant: 1");
    expect(failures).toContain("owner-a: worker_share_authorizations.target_restaurant_id rows without local restaurant: 1");
    expect(failures).toContain("owner-a: worker_share_authorizations.user_id rows without local user: 1");
    expect(failures).toContain("owner-a: worker_share_authorizations.invited_by_user_id rows without local user: 1");
  });

  test("detects staffing profile and template references outside the owner-local data", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-staffing-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO service_templates (id, restaurant_id, profile_id, role, zone, start_time, end_time, sort_order)
      VALUES ('template-bad', 'resto-a', 'missing-profile', 'floor', 'Soir', '18:00', '22:00', 0);
      INSERT INTO service_template_overrides (id, template_id, day_of_week, start_time, end_time)
      VALUES ('override-bad', 'missing-template', 5, '18:00', '22:00');
      INSERT INTO staffing_schedule (id, restaurant_id, profile_id, year, week)
      VALUES ('schedule-bad', 'resto-a', 'missing-profile', 2026, 22);
      INSERT INTO staffing_targets (id, restaurant_id, profile_id, day_of_week, role, zone, count, role_breakdown)
      VALUES ('target-bad', 'resto-a', 'missing-profile', 5, 'floor', 'Soir', 2, '{}');
      INSERT INTO staffing_analysis_cache (id, restaurant_id, profile_id, horizon_weeks, base_monday, cache_key, status, started_at)
      VALUES ('cache-bad', 'resto-a', 'missing-profile', 12, '2026-05-25', 'cache-bad', 'ok', 'now');
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: service_templates.profile_id rows without local staffing profile: 1");
    expect(failures).toContain("owner-a: service_template_overrides.template_id rows without local service template: 1");
    expect(failures).toContain("owner-a: staffing_schedule.profile_id rows without local staffing profile: 1");
    expect(failures).toContain("owner-a: staffing_targets.profile_id rows without local staffing profile: 1");
    expect(failures).toContain("owner-a: staffing_analysis_cache.profile_id rows without local staffing profile: 1");
  });

  test("detects training move worker references outside the owner-local users", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-training-move-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO sub_role_training_moves (
        id,
        restaurant_id,
        worker_id,
        move_type,
        from_role,
        to_role,
        applied_at
      )
      VALUES (
        'move-bad',
        'resto-a',
        'missing-worker',
        'intra_train',
        'Serveur',
        'Chef de rang',
        1710000000000
      )
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: sub_role_training_moves.worker_id rows without local user: 1");
  });

  test("detects onboarding token and weekly hour user references outside the owner-local users", () => {
    const source = createSourceDb();
    const directory = join(mkdtempSync(join(tmpdir(), "comptoir-phase7-owner-user-derived-scope-")), "snapshot");
    const snapshot = createPhase7CoreSnapshot({ source, directory });

    const ownerFile = snapshot.ownerPaths["owner-a"];
    const db = new Database(ownerFile);
    db.exec(`
      INSERT INTO onboarding_tokens (id, user_id, restaurant_id, token, created_at, expires_at)
      VALUES ('token-bad', 'missing-user', 'resto-a', 'token-bad', 'now', '2099-01-01');
      INSERT INTO worker_weekly_hours (worker_id, week_start, hours_actual, recorded_at, source)
      VALUES ('missing-worker', '2026-05-25', 35, 1710000000000, 'services');
    `);
    db.close();

    const failures = verifyPhase7CoreSnapshotDirectory(directory).failures;
    expect(failures).toContain("owner-a: onboarding_tokens.user_id rows without local user: 1");
    expect(failures).toContain("owner-a: worker_weekly_hours.worker_id rows without local user: 1");
  });
});
