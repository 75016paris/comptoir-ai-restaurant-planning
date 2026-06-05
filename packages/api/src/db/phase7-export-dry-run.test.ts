import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { collectPhase7DryRunSummary, collectPhase7SplitSchemaIssues, collectPhase7SplitScopeGaps } from "./phase7-export-dry-run";

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE owners (id text primary key);
    CREATE TABLE restaurants (id text primary key, owner_id text);
    CREATE TABLE users (id text primary key);
    CREATE TABLE owner_memberships (owner_id text, user_id text);
    CREATE TABLE restaurant_memberships (restaurant_id text, user_id text);
    CREATE TABLE worker_restaurant_profiles (restaurant_id text, user_id text);
    CREATE TABLE worker_share_authorizations (id text primary key, owner_id text, source_restaurant_id text, target_restaurant_id text);
    CREATE TABLE staffing_profiles (id text primary key, restaurant_id text);
    CREATE TABLE service_templates (id text primary key, restaurant_id text, profile_id text);
    CREATE TABLE service_template_overrides (id text primary key, template_id text);
    CREATE TABLE staffing_schedule (id text primary key, restaurant_id text, profile_id text);
    CREATE TABLE staffing_targets (id text primary key, restaurant_id text, profile_id text);
    CREATE TABLE staffing_analysis_cache (id text primary key, restaurant_id text, profile_id text);
    CREATE TABLE sub_role_training_costs (restaurant_id text, from_role text, to_role text);
    CREATE TABLE sub_role_training_moves (id text primary key, restaurant_id text, worker_id text);
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
    CREATE TABLE documents (id text primary key, restaurant_id text);
    CREATE TABLE audit_logs (id text primary key, restaurant_id text);
    CREATE TABLE sessions (id text primary key);
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
    CREATE TABLE notifications (id text primary key);
    CREATE TABLE chat_messages (id text primary key);
    CREATE TABLE cron_runs (id text primary key);
  `);
  return db;
}

describe("Phase 7 export dry run", () => {
  test("counts master and owner-local rows without copying data", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO owners (id) VALUES ('owner-a'), ('owner-b');
      INSERT INTO restaurants (id, owner_id) VALUES ('a1', 'owner-a'), ('a2', 'owner-a'), ('b1', 'owner-b');
      INSERT INTO users (id) VALUES ('u1'), ('u2'), ('u3');
      INSERT INTO owner_memberships (owner_id, user_id) VALUES ('owner-a', 'u1'), ('owner-a', 'u2'), ('owner-b', 'u3');
      INSERT INTO restaurant_memberships (restaurant_id, user_id) VALUES ('a1', 'u1'), ('a2', 'u2'), ('b1', 'u3');
      INSERT INTO worker_restaurant_profiles (restaurant_id, user_id) VALUES ('a1', 'u1'), ('b1', 'u3');
      INSERT INTO worker_share_authorizations (id, owner_id, source_restaurant_id, target_restaurant_id) VALUES ('share1', 'owner-a', 'a1', 'a2'), ('share2', 'owner-b', 'b1', 'b1');
      INSERT INTO staffing_profiles (id, restaurant_id) VALUES ('profile1', 'a1'), ('profile2', 'a2'), ('profile3', 'b1');
      INSERT INTO service_templates (id, restaurant_id, profile_id) VALUES ('template1', 'a1', 'profile1'), ('template2', 'b1', 'profile3');
      INSERT INTO service_template_overrides (id, template_id) VALUES ('override1', 'template1'), ('override2', 'template2');
      INSERT INTO staffing_schedule (id, restaurant_id, profile_id) VALUES ('schedule1', 'a1', 'profile1'), ('schedule2', 'b1', 'profile3');
      INSERT INTO staffing_targets (id, restaurant_id, profile_id) VALUES ('target1', 'a1', 'profile1'), ('target2', 'a2', 'profile2'), ('target3', 'b1', 'profile3');
      INSERT INTO staffing_analysis_cache (id, restaurant_id, profile_id) VALUES ('cache1', 'a1', 'profile1'), ('cache2', 'b1', 'profile3');
      INSERT INTO sub_role_training_costs (restaurant_id, from_role, to_role) VALUES ('a1', 'Serveur', 'Chef'), ('b1', 'Serveur', 'Chef');
      INSERT INTO sub_role_training_moves (id, restaurant_id, worker_id) VALUES ('move1', 'a1', 'u1'), ('move2', 'b1', 'u3');
      INSERT INTO onboarding_tokens (id, user_id, restaurant_id) VALUES ('token1', 'u1', 'a1'), ('token2', 'u3', 'b1');
      INSERT INTO worker_weekly_hours (worker_id, week_start) VALUES ('u1', '2026-05-25'), ('u3', '2026-05-25');
      INSERT INTO services (id, restaurant_id) VALUES ('s1', 'a1'), ('s2', 'a2'), ('s3', 'b1');
      INSERT INTO time_clocks (id, restaurant_id) VALUES ('tc1', 'a1'), ('tc2', 'b1');
      INSERT INTO daily_revenue (id, restaurant_id) VALUES ('rev1', 'a1'), ('rev2', 'a2'), ('rev3', 'b1');
      INSERT INTO restaurant_closures (id, restaurant_id) VALUES ('close1', 'a1'), ('close2', 'b1');
      INSERT INTO published_weeks (id, restaurant_id) VALUES ('pub1', 'a1'), ('pub2', 'b1');
      INSERT INTO calendar_events (id, restaurant_id) VALUES ('cal1', 'a1'), ('cal2', 'a2'), ('cal3', 'b1');
      INSERT INTO worker_availability (id, restaurant_id) VALUES ('avail1', 'a1'), ('avail2', 'b1');
      INSERT INTO worker_preferred_schedule (id, restaurant_id) VALUES ('pref1', 'a1'), ('pref2', 'a2'), ('pref3', 'b1');
      INSERT INTO worker_restrictions (id, restaurant_id) VALUES ('restrict1', 'a1'), ('restrict2', 'b1');
      INSERT INTO email_recipients (id, restaurant_id) VALUES ('email1', 'a1'), ('email2', 'b1');
      INSERT INTO contract_templates (id, restaurant_id) VALUES ('contract1', 'a1'), ('contract2', 'a2'), ('contract3', 'b1');
      INSERT INTO weather_data (id, restaurant_id) VALUES ('weather1', 'a1'), ('weather2', 'b1');
      INSERT INTO admin_alerts (id, restaurant_id) VALUES ('alert1', 'a1'), ('alert2', 'a2'), ('alert3', 'b1');
      INSERT INTO holiday_requests (id, restaurant_id) VALUES ('holiday1', 'a1'), ('holiday2', 'b1');
      INSERT INTO replacement_requests (id, restaurant_id) VALUES ('replacement1', 'a1'), ('replacement2', 'b1');
      INSERT INTO open_shifts (id, restaurant_id) VALUES ('open1', 'a1'), ('open2', 'a2'), ('open3', 'b1');
      INSERT INTO restriction_requests (id, restaurant_id) VALUES ('restriction-request1', 'a1'), ('restriction-request2', 'b1');
      INSERT INTO documents (id, restaurant_id) VALUES ('d1', 'a1'), ('d2', 'b1');
      INSERT INTO audit_logs (id, restaurant_id) VALUES ('audit1', 'a1'), ('audit2', 'b1');
      INSERT INTO sessions (id) VALUES ('session1');
      INSERT INTO legal_acceptances (id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version, accepted_at, created_at) VALUES ('legal1', 'owner-a', 'a1', 'u1', 'owner_terms', 'terms-v1', 'dpa-v1', 'privacy-v1', 'subprocessors-v1', 'now', 'now');
      INSERT INTO notifications (id) VALUES ('notification1');
    `);

    expect(collectPhase7DryRunSummary(db)).toEqual({
      master: {
        loginIdentities: 3,
        owners: 2,
        ownerMemberships: 3,
        ownerLegalAcceptances: 1,
        sessions: 1,
      },
      owners: [
        {
          ownerId: "owner-a",
          restaurants: 2,
          restaurantMemberships: 2,
          workerProfiles: 1,
          workerShareAuthorizations: 1,
          staffingProfiles: 2,
          serviceTemplates: 1,
          serviceTemplateOverrides: 1,
          staffingSchedule: 1,
          staffingTargets: 2,
          staffingAnalysisCache: 1,
          subRoleTrainingCosts: 1,
          subRoleTrainingMoves: 1,
          onboardingTokens: 1,
          workerWeeklyHours: 1,
          services: 2,
          timeClocks: 1,
          dailyRevenue: 2,
          restaurantClosures: 1,
          publishedWeeks: 1,
          calendarEvents: 2,
          workerAvailability: 1,
          workerPreferredSchedule: 2,
          workerRestrictions: 1,
          emailRecipients: 1,
          contractTemplates: 2,
          weatherData: 1,
          adminAlerts: 2,
          holidayRequests: 1,
          replacementRequests: 1,
          openShifts: 2,
          restrictionRequests: 1,
          documents: 1,
          auditLogs: 1,
        },
        {
          ownerId: "owner-b",
          restaurants: 1,
          restaurantMemberships: 1,
          workerProfiles: 1,
          workerShareAuthorizations: 1,
          staffingProfiles: 1,
          serviceTemplates: 1,
          serviceTemplateOverrides: 1,
          staffingSchedule: 1,
          staffingTargets: 1,
          staffingAnalysisCache: 1,
          subRoleTrainingCosts: 1,
          subRoleTrainingMoves: 1,
          onboardingTokens: 1,
          workerWeeklyHours: 1,
          services: 1,
          timeClocks: 1,
          dailyRevenue: 1,
          restaurantClosures: 1,
          publishedWeeks: 1,
          calendarEvents: 1,
          workerAvailability: 1,
          workerPreferredSchedule: 1,
          workerRestrictions: 1,
          emailRecipients: 1,
          contractTemplates: 1,
          weatherData: 1,
          adminAlerts: 1,
          holidayRequests: 1,
          replacementRequests: 1,
          openShifts: 1,
          restrictionRequests: 1,
          documents: 1,
          auditLogs: 1,
        },
      ],
      splitTables: {
        users: 3,
        legalAcceptances: 1,
        notifications: 1,
        chatMessages: 0,
        cronRuns: 0,
      },
      splitSchemaIssues: [
        {
          table: "notifications",
          missingColumns: ["owner_id", "restaurant_id"],
          reason: "needed to separate master billing/global notices from owner-local restaurant delivery attempts",
        },
        {
          table: "chat_messages",
          missingColumns: ["owner_id", "restaurant_id", "context_kind"],
          reason: "needed to separate pre-context routing messages from owner-local restaurant tool transcripts",
        },
        {
          table: "cron_runs",
          missingColumns: ["owner_id", "scope"],
          reason: "needed to separate fleet orchestration attempts from owner-local job attempts",
        },
      ],
      splitScopeGaps: [],
      failures: [],
    });
  });

  test("reports rows that cannot be assigned to an owner", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO owners (id) VALUES ('owner-a');
      INSERT INTO restaurants (id, owner_id) VALUES ('orphan-resto', NULL), ('owned-resto', 'owner-a');
      INSERT INTO worker_share_authorizations (id, owner_id, source_restaurant_id, target_restaurant_id) VALUES ('orphan-share', 'missing-owner', 'owned-resto', 'owned-resto'), ('mismatch-share', 'owner-a', 'owned-resto', 'orphan-resto');
      INSERT INTO staffing_profiles (id, restaurant_id) VALUES ('orphan-profile', 'orphan-resto');
      INSERT INTO service_templates (id, restaurant_id, profile_id) VALUES ('orphan-template', 'orphan-resto', 'orphan-profile');
      INSERT INTO service_template_overrides (id, template_id) VALUES ('orphan-template-override', 'orphan-template');
      INSERT INTO staffing_schedule (id, restaurant_id, profile_id) VALUES ('orphan-schedule', 'orphan-resto', 'orphan-profile');
      INSERT INTO staffing_targets (id, restaurant_id, profile_id) VALUES ('orphan-target', 'orphan-resto', 'orphan-profile');
      INSERT INTO staffing_analysis_cache (id, restaurant_id, profile_id) VALUES ('orphan-cache', 'orphan-resto', 'orphan-profile');
      INSERT INTO sub_role_training_costs (restaurant_id, from_role, to_role) VALUES ('orphan-resto', 'Serveur', 'Chef');
      INSERT INTO sub_role_training_moves (id, restaurant_id, worker_id) VALUES ('orphan-move', 'orphan-resto', 'u1');
      INSERT INTO onboarding_tokens (id, user_id, restaurant_id) VALUES ('orphan-token', 'u1', NULL);
      INSERT INTO worker_weekly_hours (worker_id, week_start) VALUES ('ownerless-worker', '2026-05-25');
      INSERT INTO services (id, restaurant_id) VALUES ('orphan-service', 'orphan-resto');
      INSERT INTO time_clocks (id, restaurant_id) VALUES ('orphan-time-clock', 'orphan-resto');
      INSERT INTO daily_revenue (id, restaurant_id) VALUES ('orphan-revenue', 'orphan-resto');
      INSERT INTO restaurant_closures (id, restaurant_id) VALUES ('orphan-closure', 'orphan-resto');
      INSERT INTO published_weeks (id, restaurant_id) VALUES ('orphan-published-week', 'orphan-resto');
      INSERT INTO calendar_events (id, restaurant_id) VALUES ('orphan-calendar-event', 'orphan-resto');
      INSERT INTO worker_availability (id, restaurant_id) VALUES ('orphan-availability', 'orphan-resto');
      INSERT INTO worker_preferred_schedule (id, restaurant_id) VALUES ('orphan-preferred-schedule', 'orphan-resto');
      INSERT INTO worker_restrictions (id, restaurant_id) VALUES ('orphan-restriction', 'orphan-resto');
      INSERT INTO email_recipients (id, restaurant_id) VALUES ('orphan-email-recipient', 'orphan-resto');
      INSERT INTO contract_templates (id, restaurant_id) VALUES ('orphan-contract-template', 'orphan-resto');
      INSERT INTO weather_data (id, restaurant_id) VALUES ('orphan-weather', 'orphan-resto');
      INSERT INTO admin_alerts (id, restaurant_id) VALUES ('orphan-alert', 'orphan-resto');
      INSERT INTO holiday_requests (id, restaurant_id) VALUES ('orphan-holiday', 'orphan-resto');
      INSERT INTO replacement_requests (id, restaurant_id) VALUES ('orphan-replacement', 'orphan-resto');
      INSERT INTO open_shifts (id, restaurant_id) VALUES ('orphan-open-shift', 'orphan-resto');
      INSERT INTO restriction_requests (id, restaurant_id) VALUES ('orphan-restriction-request', 'orphan-resto');
      INSERT INTO documents (id, restaurant_id) VALUES ('orphan-document', 'orphan-resto');
      INSERT INTO legal_acceptances (id, owner_id, restaurant_id, user_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version) VALUES ('orphan-legal', NULL, 'owned-resto', 'u1', 'owner_terms', 'terms-v1', 'dpa-v1', 'privacy-v1', 'subprocessors-v1');
    `);

    expect(collectPhase7DryRunSummary(db).failures).toEqual([
      "restaurants_without_owner: 1",
      "services_without_owner: 1",
      "worker_share_authorizations_without_owner: 1",
      "worker_share_authorizations_with_mismatched_owner: 1",
      "staffing_profiles_without_owner: 1",
      "service_templates_without_owner: 1",
      "staffing_schedule_without_owner: 1",
      "staffing_targets_without_owner: 1",
      "staffing_analysis_cache_without_owner: 1",
      "sub_role_training_costs_without_owner: 1",
      "sub_role_training_moves_without_owner: 1",
      "service_template_overrides_without_owner: 1",
      "onboarding_tokens_without_owner: 1",
      "worker_weekly_hours_without_owner_membership: 1",
      "legal_acceptances_without_owner: 1",
      "documents_without_owner: 1",
      "time_clocks_without_owner: 1",
      "daily_revenue_without_owner: 1",
      "restaurant_closures_without_owner: 1",
      "published_weeks_without_owner: 1",
      "calendar_events_without_owner: 1",
      "worker_availability_without_owner: 1",
      "worker_preferred_schedule_without_owner: 1",
      "worker_restrictions_without_owner: 1",
      "email_recipients_without_owner: 1",
      "contract_templates_without_owner: 1",
      "weather_data_without_owner: 1",
      "admin_alerts_without_owner: 1",
      "holiday_requests_without_owner: 1",
      "replacement_requests_without_owner: 1",
      "open_shifts_without_owner: 1",
      "restriction_requests_without_owner: 1",
    ]);
  });

  test("accepts split tables once durable scope columns exist", () => {
    const db = createDb();
    db.exec(`
      ALTER TABLE notifications ADD COLUMN type text;
      ALTER TABLE notifications ADD COLUMN owner_id text;
      ALTER TABLE notifications ADD COLUMN restaurant_id text;
      ALTER TABLE chat_messages ADD COLUMN owner_id text;
      ALTER TABLE chat_messages ADD COLUMN restaurant_id text;
      ALTER TABLE chat_messages ADD COLUMN context_kind text;
      ALTER TABLE cron_runs ADD COLUMN owner_id text;
      ALTER TABLE cron_runs ADD COLUMN scope text;
    `);

    expect(collectPhase7SplitSchemaIssues(db)).toEqual([]);
  });

  test("reports split rows that still lack durable scope after the scope columns exist", () => {
    const db = createDb();
    db.exec(`
      ALTER TABLE notifications ADD COLUMN type text;
      ALTER TABLE notifications ADD COLUMN owner_id text;
      ALTER TABLE notifications ADD COLUMN restaurant_id text;
      ALTER TABLE chat_messages ADD COLUMN owner_id text;
      ALTER TABLE chat_messages ADD COLUMN restaurant_id text;
      ALTER TABLE chat_messages ADD COLUMN context_kind text;
      ALTER TABLE cron_runs ADD COLUMN owner_id text;
      ALTER TABLE cron_runs ADD COLUMN scope text;

      INSERT INTO notifications (id, type, owner_id, restaurant_id) VALUES
        ('notif-ownerless', 'schedule_change', NULL, 'resto-a'),
        ('notif-restaurantless', 'schedule_change', 'owner-a', NULL),
        ('notif-billing', 'payment_failed', 'owner-a', NULL);
      INSERT INTO chat_messages (id, owner_id, restaurant_id, context_kind) VALUES
        ('chat-ownerless', NULL, 'resto-a', 'restaurant_context'),
        ('chat-contextless', 'owner-a', 'resto-a', NULL),
        ('chat-restaurantless', 'owner-a', NULL, 'restaurant_context'),
        ('chat-pre-context', NULL, NULL, 'pre_context');
      INSERT INTO cron_runs (id, owner_id, scope) VALUES
        (1, NULL, NULL),
        (2, NULL, 'owner'),
        (3, NULL, 'fleet');
    `);

    expect(collectPhase7SplitScopeGaps(db)).toEqual([
      { table: "notifications", issue: "missing_owner_id", count: 1 },
      { table: "notifications", issue: "restaurant_scoped_without_restaurant_id", count: 1 },
      { table: "chat_messages", issue: "missing_context_kind", count: 1 },
      { table: "chat_messages", issue: "restaurant_context_without_owner_id", count: 1 },
      { table: "chat_messages", issue: "restaurant_context_without_restaurant_id", count: 1 },
      { table: "cron_runs", issue: "missing_scope", count: 1 },
      { table: "cron_runs", issue: "owner_scope_without_owner_id", count: 1 },
    ]);
  });
});
