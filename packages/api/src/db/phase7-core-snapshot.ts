import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhase7BaselineSet } from "./phase7-baseline-runner";
import { collectPhase7DryRunSummary, type Phase7DryRunSummary } from "./phase7-export-dry-run";
import { phase7OwnerTables, phase7SplitTables } from "./phase7-schema-boundaries";

export const PHASE7_CORE_SNAPSHOT_VERSION = 1;
export const PHASE7_CORE_SNAPSHOT_MANIFEST = "phase7-snapshot-manifest.json";
export const PHASE7_CORE_SNAPSHOT_KIND = "core";
export const PHASE7_CORE_SNAPSHOT_COPIED_OWNER_TABLES = [
  "restaurants",
  "users",
  "restaurant_memberships",
  "worker_restaurant_profiles",
  "worker_share_authorizations",
  "staffing_profiles",
  "service_templates",
  "service_template_overrides",
  "staffing_schedule",
  "staffing_targets",
  "staffing_analysis_cache",
  "sub_role_training_costs",
  "sub_role_training_moves",
  "onboarding_tokens",
  "worker_weekly_hours",
  "services",
  "time_clocks",
  "daily_revenue",
  "restaurant_closures",
  "published_weeks",
  "calendar_events",
  "worker_availability",
  "worker_preferred_schedule",
  "worker_restrictions",
  "email_recipients",
  "contract_templates",
  "weather_data",
  "admin_alerts",
  "holiday_requests",
  "replacement_requests",
  "open_shifts",
  "restriction_requests",
  "documents",
  "audit_logs",
] as const;
export const PHASE7_CORE_SNAPSHOT_COPIED_SPLIT_TABLES = [
  "users",
  "legal_acceptances",
  "notifications",
  "chat_messages",
  "cron_runs",
] as const;

export type Phase7CoreSnapshotScope = {
  kind: typeof PHASE7_CORE_SNAPSHOT_KIND;
  copiedOwnerTables: string[];
  remainingOwnerTables: string[];
  remainingSplitTables: string[];
};

export type Phase7CoreSnapshotResult = {
  snapshotVersion: typeof PHASE7_CORE_SNAPSHOT_VERSION;
  scope: Phase7CoreSnapshotScope;
  directory: string;
  manifestPath: string;
  masterPath: string;
  ownerPaths: Record<string, string>;
  fileFingerprints: Record<string, {
    sha256: string;
    sizeBytes: number;
  }>;
  dryRun: Phase7DryRunSummary;
  copied: {
    master: {
      loginIdentities: number;
      owners: number;
      ownerMemberships: number;
      ownerLegalAcceptances: number;
      sessions: number;
      notifications: number;
      chatMessages: number;
      cronRuns: number;
    };
    owners: Array<{
      ownerId: string;
      restaurants: number;
      users: number;
      restaurantMemberships: number;
      workerProfiles: number;
      workerShareAuthorizations: number;
      staffingProfiles: number;
      serviceTemplates: number;
      serviceTemplateOverrides: number;
      staffingSchedule: number;
      staffingTargets: number;
      staffingAnalysisCache: number;
      subRoleTrainingCosts: number;
      subRoleTrainingMoves: number;
      onboardingTokens: number;
      workerWeeklyHours: number;
      services: number;
      timeClocks: number;
      dailyRevenue: number;
      restaurantClosures: number;
      publishedWeeks: number;
      calendarEvents: number;
      workerAvailability: number;
      workerPreferredSchedule: number;
      workerRestrictions: number;
      emailRecipients: number;
      contractTemplates: number;
      weatherData: number;
      adminAlerts: number;
      holidayRequests: number;
      replacementRequests: number;
      openShifts: number;
      restrictionRequests: number;
      documents: number;
      auditLogs: number;
      notifications: number;
      chatMessages: number;
      cronRuns: number;
    }>;
  };
};

export type Phase7CoreSnapshotManifest = Omit<Phase7CoreSnapshotResult, "dryRun"> & {
  dryRun: Phase7DryRunSummary;
};

function rows<T extends Record<string, unknown>>(db: Database, sql: string, params: Array<string | number | null> = []) {
  return db.query(sql).all(...params) as T[];
}

function one<T extends Record<string, unknown>>(db: Database, sql: string, params: Array<string | number | null> = []) {
  return db.query(sql).get(...params) as T | undefined;
}

function insertRows(db: Database, table: string, columns: readonly string[], inputRows: Array<Record<string, unknown>>) {
  if (inputRows.length === 0) return 0;

  const placeholders = columns.map(() => "?").join(", ");
  const statement = db.query(`
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${placeholders})
  `);

  const insert = db.transaction((items: Array<Record<string, unknown>>) => {
    for (const row of items) {
      statement.run(...columns.map((column) => (row[column] ?? null) as SQLQueryBindings));
    }
  });

  insert(inputRows);
  return inputRows.length;
}

function count(db: Database, table: string) {
  return Number((one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c) ?? 0);
}

function sourceOwners(source: Database) {
  return rows<{ id: string }>(source, "SELECT id FROM owners ORDER BY id").map((row) => row.id);
}

function coreSnapshotScope(): Phase7CoreSnapshotScope {
  const copied = new Set<string>(PHASE7_CORE_SNAPSHOT_COPIED_OWNER_TABLES);
  const copiedSplit = new Set<string>(PHASE7_CORE_SNAPSHOT_COPIED_SPLIT_TABLES);
  const ownerTables = phase7OwnerTables.map((entry) => entry.table).sort();
  return {
    kind: PHASE7_CORE_SNAPSHOT_KIND,
    copiedOwnerTables: [...copied].sort(),
    remainingOwnerTables: ownerTables.filter((table) => !copied.has(table)),
    remainingSplitTables: phase7SplitTables.map((entry) => entry.table).filter((table) => !copiedSplit.has(table)).sort(),
  };
}

function fileFingerprint(filePath: string) {
  return {
    sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    sizeBytes: statSync(filePath).size,
  };
}

function snapshotFingerprints(masterPath: string, ownerPaths: Record<string, string>) {
  return Object.fromEntries([
    [masterPath, fileFingerprint(masterPath)],
    ...Object.values(ownerPaths).map((filePath) => [filePath, fileFingerprint(filePath)] as const),
  ]);
}

function copyMaster(source: Database, target: Database, ownerPaths: Record<string, string>) {
  const loginIdentities = rows(source, `
    SELECT
      id,
      name AS display_name,
      first_name,
      last_name,
      email,
      phone,
      password_hash,
      active,
      must_change_password,
      user_notice_version,
      user_notice_accepted_at,
      user_notice_ip_address,
      user_notice_user_agent,
      whatsapp_opt_in,
      whatsapp_opt_in_at,
      whatsapp_opt_out_at,
      created_at
    FROM users
    ORDER BY id
  `);

  const ownerRows = rows(source, `
    SELECT
      id,
      name,
      stripe_customer_id,
      stripe_subscription_id,
      subscription_status,
      subscription_period_end,
      trial_ends_at,
      cancel_at,
      created_at
    FROM owners
    ORDER BY id
  `).map((row) => ({
    ...row,
    database_path: ownerPaths[String(row.id)] ?? "",
  }));

  const ownerMemberships = rows(source, `
    SELECT owner_id, user_id, role, created_at
    FROM owner_memberships
    ORDER BY owner_id, user_id
  `);

  const sessions = rows(source, `
    SELECT
      s.id,
      s.user_id,
      r.owner_id AS active_owner_id,
      s.active_restaurant_id,
      s.expires_at,
      s.created_at
    FROM sessions s
    LEFT JOIN restaurants r ON r.id = s.active_restaurant_id
    ORDER BY s.id
  `);

  const ownerLegalAcceptances = one(source, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legal_acceptances'")
    ? rows(source, `
    SELECT
      id,
      owner_id,
      user_id,
      acceptance_type,
      terms_version,
      dpa_version,
      privacy_version,
      subprocessors_version,
      ip_address,
      user_agent,
      accepted_at,
      created_at
    FROM legal_acceptances
    WHERE owner_id IS NOT NULL
    ORDER BY id
  `)
    : [];

  const notifications = rows(source, `
    SELECT
      id,
      recipient_id,
      owner_id,
      restaurant_id,
      type,
      channel,
      message,
      status,
      scheduled_for,
      sent_at,
      created_at
    FROM notifications
    WHERE restaurant_id IS NULL
    ORDER BY id
  `);

  const chatMessages = rows(source, `
    SELECT
      id,
      user_id,
      owner_id,
      context_kind,
      role,
      content,
      tool_calls,
      created_at
    FROM chat_messages
    WHERE context_kind = 'pre_context'
    ORDER BY id
  `);

  const cronRuns = rows(source, `
    SELECT
      id,
      job_name,
      owner_id,
      scope,
      attempt,
      status,
      started_at,
      finished_at,
      duration_ms,
      error,
      result
    FROM cron_runs
    WHERE scope = 'fleet'
    ORDER BY id
  `);

  target.exec("BEGIN");
  try {
    const copied = {
      loginIdentities: insertRows(target, "login_identities", [
        "id",
        "display_name",
        "first_name",
        "last_name",
        "email",
        "phone",
        "password_hash",
        "active",
        "must_change_password",
        "user_notice_version",
        "user_notice_accepted_at",
        "user_notice_ip_address",
        "user_notice_user_agent",
        "whatsapp_opt_in",
        "whatsapp_opt_in_at",
        "whatsapp_opt_out_at",
        "created_at",
      ], loginIdentities),
      owners: insertRows(target, "owners", [
        "id",
        "name",
        "database_path",
        "stripe_customer_id",
        "stripe_subscription_id",
        "subscription_status",
        "subscription_period_end",
        "trial_ends_at",
        "cancel_at",
        "created_at",
      ], ownerRows),
      ownerMemberships: insertRows(target, "owner_memberships", [
        "owner_id",
        "user_id",
        "role",
        "created_at",
      ], ownerMemberships),
      ownerLegalAcceptances: insertRows(target, "owner_legal_acceptances", [
        "id",
        "owner_id",
        "user_id",
        "acceptance_type",
        "terms_version",
        "dpa_version",
        "privacy_version",
        "subprocessors_version",
        "ip_address",
        "user_agent",
        "accepted_at",
        "created_at",
      ], ownerLegalAcceptances),
      sessions: insertRows(target, "sessions", [
        "id",
        "user_id",
        "active_owner_id",
        "active_restaurant_id",
        "expires_at",
        "created_at",
      ], sessions),
      notifications: insertRows(target, "notifications", [
        "id",
        "recipient_id",
        "owner_id",
        "restaurant_id",
        "type",
        "channel",
        "message",
        "status",
        "scheduled_for",
        "sent_at",
        "created_at",
      ], notifications),
      chatMessages: insertRows(target, "chat_messages", [
        "id",
        "user_id",
        "owner_id",
        "context_kind",
        "role",
        "content",
        "tool_calls",
        "created_at",
      ], chatMessages),
      cronRuns: insertRows(target, "cron_runs", [
        "id",
        "job_name",
        "owner_id",
        "scope",
        "attempt",
        "status",
        "started_at",
        "finished_at",
        "duration_ms",
        "error",
        "result",
      ], cronRuns),
    };
    target.exec("COMMIT");
    return copied;
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}

function copyOwner(source: Database, target: Database, ownerId: string) {
  const restaurants = rows(source, `
    SELECT
      id,
      name,
      address,
      siret,
      timezone,
      status,
      open_days,
      medical_mode,
      tap_in_out_enabled,
      tap_in_out_admin_confirmation,
      tap_in_out_mode,
      tap_in_counts_as_hours,
      reminder_frequency,
      color_scheme,
      kitchen_color,
      floor_color,
      worker_preferences_enabled,
      auto_staffing_weeks,
      disabled_compliance_rules,
      kitchen_sub_roles,
      floor_sub_roles,
      overtime_mode,
      overtime_weekly_cap,
      overtime_distribution,
      hcr_grid,
      subrole_hcr_map,
      default_contract_type,
      default_contract_hours,
      preferred_style,
      custom_weights,
      latitude,
      longitude,
      cache_version,
      onboarding_completed_at,
      created_at
    FROM restaurants
    WHERE owner_id = ?
    ORDER BY id
  `, [ownerId]);

  const users = rows(source, `
    SELECT DISTINCT
      u.id,
      u.name AS display_name,
      u.first_name,
      u.last_name,
      u.phone,
      u.active,
      u.created_at
    FROM users u
    INNER JOIN owner_memberships om ON om.user_id = u.id
    WHERE om.owner_id = ?
    ORDER BY u.id
  `, [ownerId]);

  const restaurantMemberships = rows(source, `
    SELECT rm.restaurant_id, rm.user_id, rm.role, rm.permissions, rm.active, rm.created_at
    FROM restaurant_memberships rm
    INNER JOIN restaurants r ON r.id = rm.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY rm.restaurant_id, rm.user_id
  `, [ownerId]);

  const workerProfiles = rows(source, `
    SELECT
      wrp.restaurant_id,
      wrp.user_id,
      wrp.priority,
      wrp.sub_roles,
      wrp.contract_type,
      wrp.contract_hours,
      wrp.contract_end_date,
      wrp.max_weekly_hours,
      wrp.admin_ot_override,
      wrp.hcr_level,
      wrp.hourly_rate,
      wrp.matricule,
      wrp.manager_notes,
      wrp.multi_restaurant_willing
    FROM worker_restaurant_profiles wrp
    INNER JOIN restaurants r ON r.id = wrp.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY wrp.restaurant_id, wrp.user_id
  `, [ownerId]);

  const workerShareAuthorizations = rows(source, `
    SELECT
      wsa.id,
      wsa.source_restaurant_id,
      wsa.target_restaurant_id,
      wsa.user_id,
      wsa.role,
      wsa.status,
      wsa.invited_by_user_id,
      wsa.worker_consented_at,
      wsa.revoked_at,
      wsa.created_at,
      wsa.updated_at
    FROM worker_share_authorizations wsa
    WHERE wsa.owner_id = ?
    ORDER BY wsa.id
  `, [ownerId]);

  const staffingProfiles = rows(source, `
    SELECT
      sp.id,
      sp.restaurant_id,
      sp.name,
      sp.sort_order,
      sp.day_priorities,
      sp.preferred_assignments,
      sp.created_at
    FROM staffing_profiles sp
    INNER JOIN restaurants r ON r.id = sp.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY sp.id
  `, [ownerId]);

  const serviceTemplates = rows(source, `
    SELECT
      st.id,
      st.restaurant_id,
      st.profile_id,
      st.role,
      st.zone,
      st.start_time,
      st.end_time,
      st.sort_order
    FROM service_templates st
    INNER JOIN restaurants r ON r.id = st.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY st.id
  `, [ownerId]);

  const serviceTemplateOverrides = rows(source, `
    SELECT
      sto.id,
      sto.template_id,
      sto.day_of_week,
      sto.start_time,
      sto.end_time
    FROM service_template_overrides sto
    INNER JOIN service_templates st ON st.id = sto.template_id
    INNER JOIN restaurants r ON r.id = st.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY sto.id
  `, [ownerId]);

  const staffingSchedule = rows(source, `
    SELECT
      ss.id,
      ss.restaurant_id,
      ss.profile_id,
      ss.year,
      ss.week
    FROM staffing_schedule ss
    INNER JOIN restaurants r ON r.id = ss.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY ss.id
  `, [ownerId]);

  const staffingTargets = rows(source, `
    SELECT
      st.id,
      st.restaurant_id,
      st.profile_id,
      st.day_of_week,
      st.role,
      st.zone,
      st.count,
      st.role_breakdown
    FROM staffing_targets st
    INNER JOIN restaurants r ON r.id = st.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY st.id
  `, [ownerId]);

  const staffingAnalysisCache = one(source, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'staffing_analysis_cache'")
    ? rows(source, `
    SELECT
      sac.id,
      sac.restaurant_id,
      sac.profile_id,
      sac.horizon_weeks,
      sac.base_monday,
      sac.cache_key,
      sac.status,
      sac.started_at,
      sac.finished_at,
      sac.duration_ms,
      sac.result,
      sac.error
    FROM staffing_analysis_cache sac
    INNER JOIN restaurants r ON r.id = sac.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY sac.id
  `, [ownerId])
    : [];

  const subRoleTrainingCosts = rows(source, `
    SELECT
      srtc.restaurant_id,
      srtc.from_role,
      srtc.to_role,
      srtc.cost_points,
      srtc.successes,
      srtc.failures,
      srtc.last_updated,
      srtc.admin_override
    FROM sub_role_training_costs srtc
    INNER JOIN restaurants r ON r.id = srtc.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY srtc.restaurant_id, srtc.from_role, srtc.to_role
  `, [ownerId]);

  const subRoleTrainingMoves = rows(source, `
    SELECT
      srtm.id,
      srtm.restaurant_id,
      srtm.worker_id,
      srtm.move_type,
      srtm.from_role,
      srtm.to_role,
      srtm.applied_at,
      srtm.observed_at,
      srtm.outcome
    FROM sub_role_training_moves srtm
    INNER JOIN restaurants r ON r.id = srtm.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY srtm.id
  `, [ownerId]);

  const onboardingTokens = rows(source, `
    SELECT
      ot.id,
      ot.user_id,
      ot.restaurant_id,
      ot.token,
      ot.created_at,
      ot.expires_at
    FROM onboarding_tokens ot
    INNER JOIN restaurants r ON r.id = ot.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY ot.id
  `, [ownerId]);

  const workerWeeklyHours = rows(source, `
    SELECT
      wwh.worker_id,
      wwh.week_start,
      wwh.hours_actual,
      wwh.recorded_at,
      wwh.source
    FROM worker_weekly_hours wwh
    INNER JOIN owner_memberships om ON om.user_id = wwh.worker_id
    WHERE om.owner_id = ?
    ORDER BY wwh.worker_id, wwh.week_start
  `, [ownerId]);

  const services = rows(source, `
    SELECT
      s.id,
      s.worker_id,
      s.restaurant_id,
      s.date,
      s.start_time,
      s.end_time,
      s.role,
      s.status,
      s.source,
      s.filled_as,
      s.notes,
      s.created_at,
      s.updated_at
    FROM services s
    INNER JOIN restaurants r ON r.id = s.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY s.id
  `, [ownerId]);

  const documents = rows(source, `
    SELECT
      d.id,
      d.user_id,
      d.restaurant_id,
      d.holiday_request_id,
      d.replacement_request_id,
      d.name,
      d.type,
      d.filename,
      d.mime_type,
      d.size,
      d.data,
      d.storage_provider,
      d.storage_key,
      d.storage_status,
      d.uploaded_by,
      d.requirement_key,
      d.issued_at,
      d.expires_at,
      d.signed_at,
      d.reviewed_at,
      d.reviewed_by,
      d.created_at
    FROM documents d
    INNER JOIN restaurants r ON r.id = d.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY d.id
  `, [ownerId]);

  const dailyRevenue = rows(source, `
    SELECT
      dr.id,
      dr.restaurant_id,
      dr.date,
      dr.amount,
      dr.notes,
      dr.created_at
    FROM daily_revenue dr
    INNER JOIN restaurants r ON r.id = dr.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY dr.id
  `, [ownerId]);

  const restaurantClosures = rows(source, `
    SELECT
      rc.id,
      rc.restaurant_id,
      rc.start_date,
      rc.end_date,
      rc.reason,
      rc.schedule,
      rc.created_at
    FROM restaurant_closures rc
    INNER JOIN restaurants r ON r.id = rc.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY rc.id
  `, [ownerId]);

  const publishedWeeks = rows(source, `
    SELECT
      pw.id,
      pw.restaurant_id,
      pw.week_date,
      pw.published_at
    FROM published_weeks pw
    INNER JOIN restaurants r ON r.id = pw.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY pw.id
  `, [ownerId]);

  const calendarEvents = rows(source, `
    SELECT
      ce.id,
      ce.restaurant_id,
      ce.type,
      ce.date,
      ce.end_date,
      ce.name,
      ce.zone,
      ce.year,
      ce.created_at
    FROM calendar_events ce
    INNER JOIN restaurants r ON r.id = ce.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY ce.id
  `, [ownerId]);

  const workerAvailability = rows(source, `
    SELECT
      wa.id,
      wa.worker_id,
      wa.restaurant_id,
      wa.day_of_week,
      wa.midi,
      wa.soir,
      wa.midi_start,
      wa.midi_end,
      wa.soir_start,
      wa.soir_end,
      wa.continuous,
      wa.zones
    FROM worker_availability wa
    INNER JOIN restaurants r ON r.id = wa.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY wa.id
  `, [ownerId]);

  const workerPreferredSchedule = rows(source, `
    SELECT
      wps.id,
      wps.worker_id,
      wps.restaurant_id,
      wps.day_of_week,
      wps.midi,
      wps.soir,
      wps.zones
    FROM worker_preferred_schedule wps
    INNER JOIN restaurants r ON r.id = wps.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY wps.id
  `, [ownerId]);

  const workerRestrictions = rows(source, `
    SELECT
      wr.id,
      wr.worker_id,
      wr.restaurant_id,
      wr.day_of_week,
      wr.start_time,
      wr.end_time,
      wr.reason,
      wr.effective_from,
      wr.effective_until,
      wr.created_at
    FROM worker_restrictions wr
    INNER JOIN restaurants r ON r.id = wr.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY wr.id
  `, [ownerId]);

  const emailRecipients = rows(source, `
    SELECT
      er.id,
      er.restaurant_id,
      er.label,
      er.email,
      er.send_monthly_digest,
      er.send_leave_alerts,
      er.created_at
    FROM email_recipients er
    INNER JOIN restaurants r ON r.id = er.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY er.id
  `, [ownerId]);

  const contractTemplates = rows(source, `
    SELECT
      ct.id,
      ct.restaurant_id,
      ct.kind,
      ct.name,
      ct.body_html,
      ct.is_default,
      ct.created_by,
      ct.created_at,
      ct.updated_at
    FROM contract_templates ct
    INNER JOIN restaurants r ON r.id = ct.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY ct.id
  `, [ownerId]);

  const weatherDataRows = rows(source, `
    SELECT
      wd.id,
      wd.restaurant_id,
      wd.date,
      wd.weather_code,
      wd.temp_max,
      wd.temp_min,
      wd.sunrise,
      wd.sunset,
      wd.normal_temp_max,
      wd.normal_temp_min,
      wd.hourly_weather_codes,
      wd.hourly_temperatures,
      wd.is_forecast,
      wd.fetched_at
    FROM weather_data wd
    INNER JOIN restaurants r ON r.id = wd.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY wd.id
  `, [ownerId]);

  const adminAlerts = rows(source, `
    SELECT
      aa.id,
      aa.restaurant_id,
      aa.recipient_id,
      aa.type,
      aa.title,
      aa.body,
      aa.action_url,
      aa.worker_id,
      aa.created_at,
      aa.seen_at
    FROM admin_alerts aa
    INNER JOIN restaurants r ON r.id = aa.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY aa.id
  `, [ownerId]);

  const holidayRequests = rows(source, `
    SELECT
      hr.id,
      hr.worker_id,
      hr.restaurant_id,
      hr.start_date,
      hr.end_date,
      hr.reason,
      hr.medical,
      hr.status,
      hr.source,
      hr.reviewed_by,
      hr.reviewed_at,
      hr.created_at
    FROM holiday_requests hr
    INNER JOIN restaurants r ON r.id = hr.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY hr.id
  `, [ownerId]);

  const replacementRequests = rows(source, `
    SELECT
      rr.id,
      rr.requester_id,
      rr.requester_service_id,
      rr.target_id,
      rr.restaurant_id,
      rr.status,
      rr.message,
      rr.responded_at,
      rr.expires_at,
      rr.candidate_ids,
      rr.candidate_scores,
      rr.admin_notified_at,
      rr.worker_notified_at,
      rr.escalation_count,
      rr.rejected_candidate_ids,
      rr.medical,
      rr.itt_reminder_sent_at,
      rr.created_at
    FROM replacement_requests rr
    INNER JOIN restaurants r ON r.id = rr.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY rr.id
  `, [ownerId]);

  const openShifts = rows(source, `
    SELECT
      os.id,
      os.restaurant_id,
      os.created_by,
      os.date,
      os.start_time,
      os.end_time,
      os.role,
      os.required_sub_roles,
      os.message,
      os.candidate_ids,
      os.rejected_candidate_ids,
      os.solicited_candidate_ids,
      os.last_solicited_at,
      os.status,
      os.claimed_by,
      os.claimed_at,
      os.service_id,
      os.expires_at,
      os.created_at
    FROM open_shifts os
    INNER JOIN restaurants r ON r.id = os.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY os.id
  `, [ownerId]);

  const restrictionRequests = rows(source, `
    SELECT
      rr.id,
      rr.worker_id,
      rr.restaurant_id,
      rr.kind,
      rr.effective_from,
      rr.effective_until,
      rr.restrictions,
      rr.status,
      rr.note,
      rr.admin_note,
      rr.reviewed_by,
      rr.reviewed_at,
      rr.created_at
    FROM restriction_requests rr
    INNER JOIN restaurants r ON r.id = rr.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY rr.id
  `, [ownerId]);

  const timeClocks = rows(source, `
    SELECT
      tc.id,
      tc.user_id,
      tc.restaurant_id,
      tc.service_id,
      tc.tap_in,
      tc.tap_out,
      tc.date,
      tc.admin_confirmed_at,
      tc.admin_confirmed_by,
      tc.created_at
    FROM time_clocks tc
    INNER JOIN restaurants r ON r.id = tc.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY tc.id
  `, [ownerId]);

  const auditLogs = rows(source, `
    SELECT
      a.id,
      a.restaurant_id,
      a.table_name,
      a.row_id,
      a.action,
      a.actor_id,
      a.actor_name,
      a.source,
      a.changes,
      a.summary,
      a.created_at
    FROM audit_logs a
    INNER JOIN restaurants r ON r.id = a.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY a.id
  `, [ownerId]);

  const notifications = rows(source, `
    SELECT
      n.id,
      n.recipient_id,
      n.restaurant_id,
      n.type,
      n.channel,
      n.message,
      n.status,
      n.scheduled_for,
      n.sent_at,
      n.created_at
    FROM notifications n
    INNER JOIN restaurants r ON r.id = n.restaurant_id
    WHERE r.owner_id = ?
    ORDER BY n.id
  `, [ownerId]);

  const chatMessages = rows(source, `
    SELECT
      cm.id,
      cm.user_id,
      cm.restaurant_id,
      cm.context_kind,
      cm.role,
      cm.content,
      cm.tool_calls,
      cm.created_at
    FROM chat_messages cm
    INNER JOIN restaurants r ON r.id = cm.restaurant_id
    WHERE r.owner_id = ?
      AND cm.context_kind = 'restaurant_context'
    ORDER BY cm.id
  `, [ownerId]);

  const cronRuns = rows(source, `
    SELECT
      cr.id,
      cr.job_name,
      cr.scope,
      cr.attempt,
      cr.status,
      cr.started_at,
      cr.finished_at,
      cr.duration_ms,
      cr.error,
      cr.result
    FROM cron_runs cr
    WHERE cr.owner_id = ?
      AND cr.scope = 'owner'
    ORDER BY cr.id
  `, [ownerId]);

  target.exec("BEGIN");
  try {
    const copied = {
      ownerId,
      restaurants: insertRows(target, "restaurants", [
        "id",
        "name",
        "address",
        "siret",
        "timezone",
        "status",
        "open_days",
        "medical_mode",
        "tap_in_out_enabled",
        "tap_in_out_admin_confirmation",
        "tap_in_out_mode",
        "tap_in_counts_as_hours",
        "reminder_frequency",
        "color_scheme",
        "kitchen_color",
        "floor_color",
        "worker_preferences_enabled",
        "auto_staffing_weeks",
        "disabled_compliance_rules",
        "kitchen_sub_roles",
        "floor_sub_roles",
        "overtime_mode",
        "overtime_weekly_cap",
        "overtime_distribution",
        "hcr_grid",
        "subrole_hcr_map",
        "default_contract_type",
        "default_contract_hours",
        "preferred_style",
        "custom_weights",
        "latitude",
        "longitude",
        "cache_version",
        "onboarding_completed_at",
        "created_at",
      ], restaurants),
      users: insertRows(target, "users", [
        "id",
        "display_name",
        "first_name",
        "last_name",
        "phone",
        "active",
        "created_at",
      ], users),
      restaurantMemberships: insertRows(target, "restaurant_memberships", [
        "restaurant_id",
        "user_id",
        "role",
        "permissions",
        "active",
        "created_at",
      ], restaurantMemberships),
      workerProfiles: insertRows(target, "worker_restaurant_profiles", [
        "restaurant_id",
        "user_id",
        "priority",
        "sub_roles",
        "contract_type",
        "contract_hours",
        "contract_end_date",
        "max_weekly_hours",
        "admin_ot_override",
        "hcr_level",
        "hourly_rate",
        "matricule",
        "manager_notes",
        "multi_restaurant_willing",
      ], workerProfiles),
      workerShareAuthorizations: insertRows(target, "worker_share_authorizations", [
        "id",
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
      ], workerShareAuthorizations),
      staffingProfiles: insertRows(target, "staffing_profiles", [
        "id",
        "restaurant_id",
        "name",
        "sort_order",
        "day_priorities",
        "preferred_assignments",
        "created_at",
      ], staffingProfiles),
      serviceTemplates: insertRows(target, "service_templates", [
        "id",
        "restaurant_id",
        "profile_id",
        "role",
        "zone",
        "start_time",
        "end_time",
        "sort_order",
      ], serviceTemplates),
      serviceTemplateOverrides: insertRows(target, "service_template_overrides", [
        "id",
        "template_id",
        "day_of_week",
        "start_time",
        "end_time",
      ], serviceTemplateOverrides),
      staffingSchedule: insertRows(target, "staffing_schedule", [
        "id",
        "restaurant_id",
        "profile_id",
        "year",
        "week",
      ], staffingSchedule),
      staffingTargets: insertRows(target, "staffing_targets", [
        "id",
        "restaurant_id",
        "profile_id",
        "day_of_week",
        "role",
        "zone",
        "count",
        "role_breakdown",
      ], staffingTargets),
      staffingAnalysisCache: insertRows(target, "staffing_analysis_cache", [
        "id",
        "restaurant_id",
        "profile_id",
        "horizon_weeks",
        "base_monday",
        "cache_key",
        "status",
        "started_at",
        "finished_at",
        "duration_ms",
        "result",
        "error",
      ], staffingAnalysisCache),
      subRoleTrainingCosts: insertRows(target, "sub_role_training_costs", [
        "restaurant_id",
        "from_role",
        "to_role",
        "cost_points",
        "successes",
        "failures",
        "last_updated",
        "admin_override",
      ], subRoleTrainingCosts),
      subRoleTrainingMoves: insertRows(target, "sub_role_training_moves", [
        "id",
        "restaurant_id",
        "worker_id",
        "move_type",
        "from_role",
        "to_role",
        "applied_at",
        "observed_at",
        "outcome",
      ], subRoleTrainingMoves),
      onboardingTokens: insertRows(target, "onboarding_tokens", [
        "id",
        "user_id",
        "restaurant_id",
        "token",
        "created_at",
        "expires_at",
      ], onboardingTokens),
      workerWeeklyHours: insertRows(target, "worker_weekly_hours", [
        "worker_id",
        "week_start",
        "hours_actual",
        "recorded_at",
        "source",
      ], workerWeeklyHours),
      services: insertRows(target, "services", [
        "id",
        "worker_id",
        "restaurant_id",
        "date",
        "start_time",
        "end_time",
        "role",
        "status",
        "source",
        "filled_as",
        "notes",
        "created_at",
        "updated_at",
      ], services),
      timeClocks: insertRows(target, "time_clocks", [
        "id",
        "user_id",
        "restaurant_id",
        "service_id",
        "tap_in",
        "tap_out",
        "date",
        "admin_confirmed_at",
        "admin_confirmed_by",
        "created_at",
      ], timeClocks),
      dailyRevenue: insertRows(target, "daily_revenue", [
        "id",
        "restaurant_id",
        "date",
        "amount",
        "notes",
        "created_at",
      ], dailyRevenue),
      restaurantClosures: insertRows(target, "restaurant_closures", [
        "id",
        "restaurant_id",
        "start_date",
        "end_date",
        "reason",
        "schedule",
        "created_at",
      ], restaurantClosures),
      publishedWeeks: insertRows(target, "published_weeks", [
        "id",
        "restaurant_id",
        "week_date",
        "published_at",
      ], publishedWeeks),
      calendarEvents: insertRows(target, "calendar_events", [
        "id",
        "restaurant_id",
        "type",
        "date",
        "end_date",
        "name",
        "zone",
        "year",
        "created_at",
      ], calendarEvents),
      workerAvailability: insertRows(target, "worker_availability", [
        "id",
        "worker_id",
        "restaurant_id",
        "day_of_week",
        "midi",
        "soir",
        "midi_start",
        "midi_end",
        "soir_start",
        "soir_end",
        "continuous",
        "zones",
      ], workerAvailability),
      workerPreferredSchedule: insertRows(target, "worker_preferred_schedule", [
        "id",
        "worker_id",
        "restaurant_id",
        "day_of_week",
        "midi",
        "soir",
        "zones",
      ], workerPreferredSchedule),
      workerRestrictions: insertRows(target, "worker_restrictions", [
        "id",
        "worker_id",
        "restaurant_id",
        "day_of_week",
        "start_time",
        "end_time",
        "reason",
        "effective_from",
        "effective_until",
        "created_at",
      ], workerRestrictions),
      emailRecipients: insertRows(target, "email_recipients", [
        "id",
        "restaurant_id",
        "label",
        "email",
        "send_monthly_digest",
        "send_leave_alerts",
        "created_at",
      ], emailRecipients),
      contractTemplates: insertRows(target, "contract_templates", [
        "id",
        "restaurant_id",
        "kind",
        "name",
        "body_html",
        "is_default",
        "created_by",
        "created_at",
        "updated_at",
      ], contractTemplates),
      weatherData: insertRows(target, "weather_data", [
        "id",
        "restaurant_id",
        "date",
        "weather_code",
        "temp_max",
        "temp_min",
        "sunrise",
        "sunset",
        "normal_temp_max",
        "normal_temp_min",
        "hourly_weather_codes",
        "hourly_temperatures",
        "is_forecast",
        "fetched_at",
      ], weatherDataRows),
      adminAlerts: insertRows(target, "admin_alerts", [
        "id",
        "restaurant_id",
        "recipient_id",
        "type",
        "title",
        "body",
        "action_url",
        "worker_id",
        "created_at",
        "seen_at",
      ], adminAlerts),
      holidayRequests: insertRows(target, "holiday_requests", [
        "id",
        "worker_id",
        "restaurant_id",
        "start_date",
        "end_date",
        "reason",
        "medical",
        "status",
        "source",
        "reviewed_by",
        "reviewed_at",
        "created_at",
      ], holidayRequests),
      replacementRequests: insertRows(target, "replacement_requests", [
        "id",
        "requester_id",
        "requester_service_id",
        "target_id",
        "restaurant_id",
        "status",
        "message",
        "responded_at",
        "expires_at",
        "candidate_ids",
        "candidate_scores",
        "admin_notified_at",
        "worker_notified_at",
        "escalation_count",
        "rejected_candidate_ids",
        "medical",
        "itt_reminder_sent_at",
        "created_at",
      ], replacementRequests),
      openShifts: insertRows(target, "open_shifts", [
        "id",
        "restaurant_id",
        "created_by",
        "date",
        "start_time",
        "end_time",
        "role",
        "required_sub_roles",
        "message",
        "candidate_ids",
        "rejected_candidate_ids",
        "solicited_candidate_ids",
        "last_solicited_at",
        "status",
        "claimed_by",
        "claimed_at",
        "service_id",
        "expires_at",
        "created_at",
      ], openShifts),
      restrictionRequests: insertRows(target, "restriction_requests", [
        "id",
        "worker_id",
        "restaurant_id",
        "kind",
        "effective_from",
        "effective_until",
        "restrictions",
        "status",
        "note",
        "admin_note",
        "reviewed_by",
        "reviewed_at",
        "created_at",
      ], restrictionRequests),
      documents: insertRows(target, "documents", [
        "id",
        "user_id",
        "restaurant_id",
        "holiday_request_id",
        "replacement_request_id",
        "name",
        "type",
        "filename",
        "mime_type",
        "size",
        "data",
        "storage_provider",
        "storage_key",
        "storage_status",
        "uploaded_by",
        "requirement_key",
        "issued_at",
        "expires_at",
        "signed_at",
        "reviewed_at",
        "reviewed_by",
        "created_at",
      ], documents),
      auditLogs: insertRows(target, "audit_logs", [
        "id",
        "restaurant_id",
        "table_name",
        "row_id",
        "action",
        "actor_id",
        "actor_name",
        "source",
        "changes",
        "summary",
        "created_at",
      ], auditLogs),
      notifications: insertRows(target, "notifications", [
        "id",
        "recipient_id",
        "restaurant_id",
        "type",
        "channel",
        "message",
        "status",
        "scheduled_for",
        "sent_at",
        "created_at",
      ], notifications),
      chatMessages: insertRows(target, "chat_messages", [
        "id",
        "user_id",
        "restaurant_id",
        "context_kind",
        "role",
        "content",
        "tool_calls",
        "created_at",
      ], chatMessages),
      cronRuns: insertRows(target, "cron_runs", [
        "id",
        "job_name",
        "scope",
        "attempt",
        "status",
        "started_at",
        "finished_at",
        "duration_ms",
        "error",
        "result",
      ], cronRuns),
    };
    target.exec("COMMIT");
    return copied;
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}

export function createPhase7CoreSnapshot(input: {
  source: Database;
  directory: string;
}): Phase7CoreSnapshotResult {
  if (existsSync(input.directory)) {
    throw new Error(`Output directory already exists: ${input.directory}`);
  }

  const dryRun = collectPhase7DryRunSummary(input.source);
  if (dryRun.failures.length > 0) {
    throw new Error(`Phase 7 dry-run has failures:\n${dryRun.failures.join("\n")}`);
  }
  if (dryRun.splitSchemaIssues.length > 0) {
    throw new Error(`Phase 7 split schema is not ready:\n${dryRun.splitSchemaIssues.map((issue) => `${issue.table}: missing ${issue.missingColumns.join(", ")}`).join("\n")}`);
  }
  if (dryRun.splitScopeGaps.length > 0) {
    throw new Error(`Phase 7 split scope has gaps:\n${dryRun.splitScopeGaps.map((gap) => `${gap.table}.${gap.issue}: ${gap.count}`).join("\n")}`);
  }

  const ownerIds = sourceOwners(input.source);
  const baseline = createPhase7BaselineSet({
    directory: input.directory,
    owners: ownerIds,
  });

  const ownerPaths = Object.fromEntries(ownerIds.map((ownerId) => [
    ownerId,
    join(input.directory, "owners", encodeURIComponent(ownerId), "comptoir.sqlite"),
  ]));

  const masterSnapshot = new Database(baseline.master.filePath);
  const copiedMaster = copyMaster(input.source, masterSnapshot, ownerPaths);
  masterSnapshot.close();

  const copiedOwners = ownerIds.map((ownerId) => {
    const ownerSnapshot = new Database(ownerPaths[ownerId]);
    try {
      return copyOwner(input.source, ownerSnapshot, ownerId);
    } finally {
      ownerSnapshot.close();
    }
  });

  const fileFingerprints = snapshotFingerprints(baseline.master.filePath, ownerPaths);

  const result: Phase7CoreSnapshotResult = {
    snapshotVersion: PHASE7_CORE_SNAPSHOT_VERSION,
    scope: coreSnapshotScope(),
    directory: input.directory,
    manifestPath: join(input.directory, PHASE7_CORE_SNAPSHOT_MANIFEST),
    masterPath: baseline.master.filePath,
    ownerPaths,
    fileFingerprints,
    dryRun,
    copied: {
      master: copiedMaster,
      owners: copiedOwners,
    },
  };

  writeFileSync(result.manifestPath, `${JSON.stringify(result, null, 2)}\n`);

  return result;
}

export function verifyPhase7CoreSnapshot(result: Phase7CoreSnapshotResult) {
  const failures: string[] = [];

  if (result.copied.master.loginIdentities !== result.dryRun.master.loginIdentities) {
    failures.push(`master login identity count mismatch: copied ${result.copied.master.loginIdentities}, expected ${result.dryRun.master.loginIdentities}`);
  }
  if (result.copied.master.owners !== result.dryRun.master.owners) {
    failures.push(`master owner count mismatch: copied ${result.copied.master.owners}, expected ${result.dryRun.master.owners}`);
  }
  if (result.copied.master.ownerMemberships !== result.dryRun.master.ownerMemberships) {
    failures.push(`master owner membership count mismatch: copied ${result.copied.master.ownerMemberships}, expected ${result.dryRun.master.ownerMemberships}`);
  }
  if (result.copied.master.ownerLegalAcceptances !== result.dryRun.master.ownerLegalAcceptances) {
    failures.push(`master owner legal acceptance count mismatch: copied ${result.copied.master.ownerLegalAcceptances}, expected ${result.dryRun.master.ownerLegalAcceptances}`);
  }
  if (result.copied.master.sessions !== result.dryRun.master.sessions) {
    failures.push(`master session count mismatch: copied ${result.copied.master.sessions}, expected ${result.dryRun.master.sessions}`);
  }

  const copiedSplitTotals = {
    notifications: result.copied.master.notifications + result.copied.owners.reduce((sum, owner) => sum + owner.notifications, 0),
    chatMessages: result.copied.master.chatMessages + result.copied.owners.reduce((sum, owner) => sum + owner.chatMessages, 0),
    cronRuns: result.copied.master.cronRuns + result.copied.owners.reduce((sum, owner) => sum + owner.cronRuns, 0),
  };
  if (copiedSplitTotals.notifications !== result.dryRun.splitTables.notifications) {
    failures.push(`split notification count mismatch: copied ${copiedSplitTotals.notifications}, expected ${result.dryRun.splitTables.notifications}`);
  }
  if (copiedSplitTotals.chatMessages !== result.dryRun.splitTables.chatMessages) {
    failures.push(`split chat message count mismatch: copied ${copiedSplitTotals.chatMessages}, expected ${result.dryRun.splitTables.chatMessages}`);
  }
  if (copiedSplitTotals.cronRuns !== result.dryRun.splitTables.cronRuns) {
    failures.push(`split cron run count mismatch: copied ${copiedSplitTotals.cronRuns}, expected ${result.dryRun.splitTables.cronRuns}`);
  }

  for (const owner of result.dryRun.owners) {
    const copied = result.copied.owners.find((entry) => entry.ownerId === owner.ownerId);
    if (!copied) {
      failures.push(`missing copied owner ${owner.ownerId}`);
      continue;
    }
    if (copied.restaurants !== owner.restaurants) {
      failures.push(`${owner.ownerId} restaurant count mismatch: copied ${copied.restaurants}, expected ${owner.restaurants}`);
    }
    if (copied.restaurantMemberships !== owner.restaurantMemberships) {
      failures.push(`${owner.ownerId} membership count mismatch: copied ${copied.restaurantMemberships}, expected ${owner.restaurantMemberships}`);
    }
    if (copied.workerProfiles !== owner.workerProfiles) {
      failures.push(`${owner.ownerId} worker profile count mismatch: copied ${copied.workerProfiles}, expected ${owner.workerProfiles}`);
    }
    if (copied.workerShareAuthorizations !== owner.workerShareAuthorizations) {
      failures.push(`${owner.ownerId} worker share authorization count mismatch: copied ${copied.workerShareAuthorizations}, expected ${owner.workerShareAuthorizations}`);
    }
    if (copied.staffingProfiles !== owner.staffingProfiles) {
      failures.push(`${owner.ownerId} staffing profile count mismatch: copied ${copied.staffingProfiles}, expected ${owner.staffingProfiles}`);
    }
    if (copied.serviceTemplates !== owner.serviceTemplates) {
      failures.push(`${owner.ownerId} service template count mismatch: copied ${copied.serviceTemplates}, expected ${owner.serviceTemplates}`);
    }
    if (copied.serviceTemplateOverrides !== owner.serviceTemplateOverrides) {
      failures.push(`${owner.ownerId} service template override count mismatch: copied ${copied.serviceTemplateOverrides}, expected ${owner.serviceTemplateOverrides}`);
    }
    if (copied.staffingSchedule !== owner.staffingSchedule) {
      failures.push(`${owner.ownerId} staffing schedule count mismatch: copied ${copied.staffingSchedule}, expected ${owner.staffingSchedule}`);
    }
    if (copied.staffingTargets !== owner.staffingTargets) {
      failures.push(`${owner.ownerId} staffing target count mismatch: copied ${copied.staffingTargets}, expected ${owner.staffingTargets}`);
    }
    if (copied.staffingAnalysisCache !== owner.staffingAnalysisCache) {
      failures.push(`${owner.ownerId} staffing analysis cache count mismatch: copied ${copied.staffingAnalysisCache}, expected ${owner.staffingAnalysisCache}`);
    }
    if (copied.subRoleTrainingCosts !== owner.subRoleTrainingCosts) {
      failures.push(`${owner.ownerId} sub-role training cost count mismatch: copied ${copied.subRoleTrainingCosts}, expected ${owner.subRoleTrainingCosts}`);
    }
    if (copied.subRoleTrainingMoves !== owner.subRoleTrainingMoves) {
      failures.push(`${owner.ownerId} sub-role training move count mismatch: copied ${copied.subRoleTrainingMoves}, expected ${owner.subRoleTrainingMoves}`);
    }
    if (copied.onboardingTokens !== owner.onboardingTokens) {
      failures.push(`${owner.ownerId} onboarding token count mismatch: copied ${copied.onboardingTokens}, expected ${owner.onboardingTokens}`);
    }
    if (copied.workerWeeklyHours !== owner.workerWeeklyHours) {
      failures.push(`${owner.ownerId} worker weekly hour count mismatch: copied ${copied.workerWeeklyHours}, expected ${owner.workerWeeklyHours}`);
    }
    if (copied.services !== owner.services) {
      failures.push(`${owner.ownerId} service count mismatch: copied ${copied.services}, expected ${owner.services}`);
    }
    if (copied.timeClocks !== owner.timeClocks) {
      failures.push(`${owner.ownerId} time clock count mismatch: copied ${copied.timeClocks}, expected ${owner.timeClocks}`);
    }
    if (copied.dailyRevenue !== owner.dailyRevenue) {
      failures.push(`${owner.ownerId} daily revenue count mismatch: copied ${copied.dailyRevenue}, expected ${owner.dailyRevenue}`);
    }
    if (copied.restaurantClosures !== owner.restaurantClosures) {
      failures.push(`${owner.ownerId} restaurant closure count mismatch: copied ${copied.restaurantClosures}, expected ${owner.restaurantClosures}`);
    }
    if (copied.publishedWeeks !== owner.publishedWeeks) {
      failures.push(`${owner.ownerId} published week count mismatch: copied ${copied.publishedWeeks}, expected ${owner.publishedWeeks}`);
    }
    if (copied.calendarEvents !== owner.calendarEvents) {
      failures.push(`${owner.ownerId} calendar event count mismatch: copied ${copied.calendarEvents}, expected ${owner.calendarEvents}`);
    }
    if (copied.workerAvailability !== owner.workerAvailability) {
      failures.push(`${owner.ownerId} worker availability count mismatch: copied ${copied.workerAvailability}, expected ${owner.workerAvailability}`);
    }
    if (copied.workerPreferredSchedule !== owner.workerPreferredSchedule) {
      failures.push(`${owner.ownerId} worker preferred schedule count mismatch: copied ${copied.workerPreferredSchedule}, expected ${owner.workerPreferredSchedule}`);
    }
    if (copied.workerRestrictions !== owner.workerRestrictions) {
      failures.push(`${owner.ownerId} worker restriction count mismatch: copied ${copied.workerRestrictions}, expected ${owner.workerRestrictions}`);
    }
    if (copied.emailRecipients !== owner.emailRecipients) {
      failures.push(`${owner.ownerId} email recipient count mismatch: copied ${copied.emailRecipients}, expected ${owner.emailRecipients}`);
    }
    if (copied.contractTemplates !== owner.contractTemplates) {
      failures.push(`${owner.ownerId} contract template count mismatch: copied ${copied.contractTemplates}, expected ${owner.contractTemplates}`);
    }
    if (copied.weatherData !== owner.weatherData) {
      failures.push(`${owner.ownerId} weather data count mismatch: copied ${copied.weatherData}, expected ${owner.weatherData}`);
    }
    if (copied.adminAlerts !== owner.adminAlerts) {
      failures.push(`${owner.ownerId} admin alert count mismatch: copied ${copied.adminAlerts}, expected ${owner.adminAlerts}`);
    }
    if (copied.holidayRequests !== owner.holidayRequests) {
      failures.push(`${owner.ownerId} holiday request count mismatch: copied ${copied.holidayRequests}, expected ${owner.holidayRequests}`);
    }
    if (copied.replacementRequests !== owner.replacementRequests) {
      failures.push(`${owner.ownerId} replacement request count mismatch: copied ${copied.replacementRequests}, expected ${owner.replacementRequests}`);
    }
    if (copied.openShifts !== owner.openShifts) {
      failures.push(`${owner.ownerId} open shift count mismatch: copied ${copied.openShifts}, expected ${owner.openShifts}`);
    }
    if (copied.restrictionRequests !== owner.restrictionRequests) {
      failures.push(`${owner.ownerId} restriction request count mismatch: copied ${copied.restrictionRequests}, expected ${owner.restrictionRequests}`);
    }
    if (copied.documents !== owner.documents) {
      failures.push(`${owner.ownerId} document count mismatch: copied ${copied.documents}, expected ${owner.documents}`);
    }
    if (copied.auditLogs !== owner.auditLogs) {
      failures.push(`${owner.ownerId} audit log count mismatch: copied ${copied.auditLogs}, expected ${owner.auditLogs}`);
    }
  }

  return failures;
}
