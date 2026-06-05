import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PHASE7_CORE_SNAPSHOT_MANIFEST,
  PHASE7_CORE_SNAPSHOT_COPIED_OWNER_TABLES,
  PHASE7_CORE_SNAPSHOT_COPIED_SPLIT_TABLES,
  PHASE7_CORE_SNAPSHOT_KIND,
  PHASE7_CORE_SNAPSHOT_VERSION,
  type Phase7CoreSnapshotManifest,
} from "./phase7-core-snapshot";
import { phase7OwnerTables, phase7SplitTables } from "./phase7-schema-boundaries";

export type Phase7SnapshotVerification = {
  directory: string;
  manifestPath: string;
  masterPath: string;
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
  checkedOwners: Array<{
    ownerId: string;
    filePath: string;
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
  failures: string[];
};

type OwnerLocationRow = {
  id: string;
  database_path: string;
};

type SessionContextRow = {
  id: string;
  user_id: string;
  active_owner_id: string | null;
  active_restaurant_id: string | null;
};

function count(db: Database, sql: string): number {
  const row = db.query(sql).get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

function strings(db: Database, sql: string, params: string[] = []) {
  return (db.query(sql).all(...params) as Array<{ value: string }>)
    .map((row) => row.value)
    .sort();
}

function tableExists(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

function columnNames(db: Database, table: string) {
  return db.query(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
}

function fileFingerprint(filePath: string) {
  return {
    sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    sizeBytes: statSync(filePath).size,
  };
}

function verifyFingerprint(manifest: Phase7CoreSnapshotManifest, filePath: string) {
  const expected = manifest.fileFingerprints[filePath];
  if (!expected) return [`manifest: missing fingerprint for ${filePath}`];
  if (!existsSync(filePath)) return [`missing file ${filePath}`];

  const actual = fileFingerprint(filePath);
  const failures: string[] = [];
  if (actual.sha256 !== expected.sha256) {
    failures.push(`fingerprint mismatch for ${filePath}`);
  }
  if (actual.sizeBytes !== expected.sizeBytes) {
    failures.push(`size mismatch for ${filePath}: ${actual.sizeBytes} != ${expected.sizeBytes}`);
  }
  return failures;
}

function ownerScopedDanglingRestaurantRows(db: Database, table: string, restaurantColumn = "restaurant_id") {
  if (!tableExists(db, table)) return 0;
  return count(db, `
    SELECT COUNT(*) AS c
    FROM ${table} child
    LEFT JOIN restaurants r ON r.id = child.${restaurantColumn}
    WHERE r.id IS NULL
  `);
}

function ownerScopedDanglingUserRows(db: Database, table: string, userColumn: string) {
  if (!tableExists(db, table)) return 0;
  return count(db, `
    SELECT COUNT(*) AS c
    FROM ${table} child
    LEFT JOIN users u ON u.id = child.${userColumn}
    WHERE child.${userColumn} IS NOT NULL
      AND u.id IS NULL
  `);
}

function ownerScopedDanglingServiceRows(db: Database, table: string, serviceColumn = "service_id") {
  if (!tableExists(db, table)) return 0;
  return count(db, `
    SELECT COUNT(*) AS c
    FROM ${table} child
    LEFT JOIN services s ON s.id = child.${serviceColumn}
    WHERE child.${serviceColumn} IS NOT NULL
      AND s.id IS NULL
  `);
}

function ownerScopedDanglingProfileRows(db: Database, table: string, profileColumn = "profile_id") {
  if (!tableExists(db, table)) return 0;
  return count(db, `
    SELECT COUNT(*) AS c
    FROM ${table} child
    LEFT JOIN staffing_profiles sp ON sp.id = child.${profileColumn}
    WHERE child.${profileColumn} IS NOT NULL
      AND sp.id IS NULL
  `);
}

function ownerScopedDanglingTemplateRows(db: Database, table: string, templateColumn = "template_id") {
  if (!tableExists(db, table)) return 0;
  return count(db, `
    SELECT COUNT(*) AS c
    FROM ${table} child
    LEFT JOIN service_templates st ON st.id = child.${templateColumn}
    WHERE child.${templateColumn} IS NOT NULL
      AND st.id IS NULL
  `);
}

function ownerScopedDanglingJsonUserIds(db: Database, table: string, jsonColumn: string) {
  if (!tableExists(db, table)) return { dangling: 0, malformed: 0 };

  const userIds = new Set(strings(db, "SELECT id AS value FROM users ORDER BY id"));
  const rows = db.query(`
    SELECT id, ${jsonColumn} AS payload
    FROM ${table}
    WHERE ${jsonColumn} IS NOT NULL
      AND ${jsonColumn} != ''
  `).all() as Array<{ id: string; payload: string }>;

  let dangling = 0;
  let malformed = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      malformed += 1;
      continue;
    }

    if (!Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }

    for (const value of parsed) {
      if (typeof value === "string" && !userIds.has(value)) dangling += 1;
    }
  }

  return { dangling, malformed };
}

function formatIdList(ids: string[]) {
  const visible = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${visible}, ... (+${ids.length - 5})` : visible;
}

function diffSortedIds(actual: string[], expected: string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((id) => !actualSet.has(id)),
    extra: actual.filter((id) => !expectedSet.has(id)),
  };
}

function sorted(values: readonly string[]) {
  return [...values].sort();
}

function verifyExactList(label: string, actual: string[] | undefined, expected: string[]) {
  if (!actual) return [`manifest: missing ${label}`];

  const normalizedActual = sorted(actual);
  const normalizedExpected = sorted(expected);
  if (JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected)) return [];

  const diff = diffSortedIds(normalizedActual, normalizedExpected);
  return [`manifest: ${label} mismatch; missing [${formatIdList(diff.missing)}], extra [${formatIdList(diff.extra)}]`];
}

function expectedCoreScope() {
  const copied = sorted(PHASE7_CORE_SNAPSHOT_COPIED_OWNER_TABLES);
  const copiedSplit = new Set<string>(PHASE7_CORE_SNAPSHOT_COPIED_SPLIT_TABLES);
  const ownerTables = sorted(phase7OwnerTables.map((entry) => entry.table));
  const copiedSet = new Set(copied);
  return {
    copiedOwnerTables: copied,
    remainingOwnerTables: ownerTables.filter((table) => !copiedSet.has(table)),
    remainingSplitTables: sorted(phase7SplitTables.map((entry) => entry.table).filter((table) => !copiedSplit.has(table))),
  };
}

function ownerDataUserIds(filePath: string) {
  if (!existsSync(filePath)) return [];
  const db = new Database(filePath, { readonly: true });
  try {
    if (!tableExists(db, "users")) return [];
    return strings(db, "SELECT id AS value FROM users ORDER BY id");
  } finally {
    db.close();
  }
}

function ownerDataRestaurantIds(filePath: string) {
  if (!existsSync(filePath)) return [];
  const db = new Database(filePath, { readonly: true });
  try {
    if (!tableExists(db, "restaurants")) return [];
    return strings(db, "SELECT id AS value FROM restaurants ORDER BY id");
  } finally {
    db.close();
  }
}

function verifyOwnerDataFile(ownerId: string, filePath: string) {
  const failures: string[] = [];
  if (!existsSync(filePath)) {
    return {
      result: {
        ownerId,
        filePath,
        restaurants: 0,
        users: 0,
        restaurantMemberships: 0,
        workerProfiles: 0,
        workerShareAuthorizations: 0,
        staffingProfiles: 0,
        serviceTemplates: 0,
        serviceTemplateOverrides: 0,
        staffingSchedule: 0,
        staffingTargets: 0,
        staffingAnalysisCache: 0,
        subRoleTrainingCosts: 0,
        subRoleTrainingMoves: 0,
        onboardingTokens: 0,
        workerWeeklyHours: 0,
        services: 0,
        timeClocks: 0,
        dailyRevenue: 0,
        restaurantClosures: 0,
        publishedWeeks: 0,
        calendarEvents: 0,
        workerAvailability: 0,
        workerPreferredSchedule: 0,
        workerRestrictions: 0,
        emailRecipients: 0,
        contractTemplates: 0,
        weatherData: 0,
        adminAlerts: 0,
        holidayRequests: 0,
        replacementRequests: 0,
        openShifts: 0,
        restrictionRequests: 0,
        documents: 0,
        auditLogs: 0,
        notifications: 0,
        chatMessages: 0,
        cronRuns: 0,
      },
      failures: [`${ownerId}: missing owner data file ${filePath}`],
    };
  }

  const db = new Database(filePath, { readonly: true });
  try {
    for (const table of ["restaurants", "users", "restaurant_memberships", "worker_restaurant_profiles", "worker_share_authorizations", "staffing_profiles", "service_templates", "service_template_overrides", "staffing_schedule", "staffing_targets", "staffing_analysis_cache", "sub_role_training_costs", "sub_role_training_moves", "onboarding_tokens", "worker_weekly_hours", "services", "time_clocks", "daily_revenue", "restaurant_closures", "published_weeks", "calendar_events", "worker_availability", "worker_preferred_schedule", "worker_restrictions", "email_recipients", "contract_templates", "weather_data", "admin_alerts", "holiday_requests", "replacement_requests", "open_shifts", "restriction_requests", "documents", "audit_logs", "notifications", "chat_messages", "cron_runs"]) {
      if (!tableExists(db, table)) failures.push(`${ownerId}: missing table ${table}`);
    }

    if (tableExists(db, "users")) {
      const userColumns = columnNames(db, "users");
      for (const forbidden of ["email", "password_hash", "iban", "nir"]) {
        if (userColumns.includes(forbidden)) failures.push(`${ownerId}: owner users table exposes ${forbidden}`);
      }
    }

    const restaurantScopedTables = [
      "restaurant_memberships",
      "worker_restaurant_profiles",
      ["worker_share_authorizations", "source_restaurant_id"],
      ["worker_share_authorizations", "target_restaurant_id"],
      "staffing_profiles",
      "service_templates",
      "staffing_schedule",
      "staffing_targets",
      "staffing_analysis_cache",
      "sub_role_training_costs",
      "sub_role_training_moves",
      "onboarding_tokens",
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
      "notifications",
      "chat_messages",
    ];
    for (const entry of restaurantScopedTables) {
      const table = Array.isArray(entry) ? entry[0] : entry;
      const column = Array.isArray(entry) ? entry[1] : "restaurant_id";
      const dangling = ownerScopedDanglingRestaurantRows(db, table, column);
      const label = column === "restaurant_id" ? table : `${table}.${column}`;
      if (dangling > 0) failures.push(`${ownerId}: ${label} rows without local restaurant: ${dangling}`);
    }

    for (const [table, column] of [
      ["restaurant_memberships", "user_id"],
      ["worker_restaurant_profiles", "user_id"],
      ["worker_share_authorizations", "user_id"],
      ["worker_share_authorizations", "invited_by_user_id"],
      ["sub_role_training_moves", "worker_id"],
      ["onboarding_tokens", "user_id"],
      ["worker_weekly_hours", "worker_id"],
      ["services", "worker_id"],
      ["worker_availability", "worker_id"],
      ["worker_preferred_schedule", "worker_id"],
      ["worker_restrictions", "worker_id"],
      ["time_clocks", "user_id"],
      ["time_clocks", "admin_confirmed_by"],
      ["documents", "user_id"],
      ["documents", "uploaded_by"],
      ["documents", "reviewed_by"],
      ["contract_templates", "created_by"],
      ["admin_alerts", "recipient_id"],
      ["admin_alerts", "worker_id"],
      ["holiday_requests", "worker_id"],
      ["holiday_requests", "reviewed_by"],
      ["replacement_requests", "requester_id"],
      ["replacement_requests", "target_id"],
      ["open_shifts", "created_by"],
      ["open_shifts", "claimed_by"],
      ["restriction_requests", "worker_id"],
      ["restriction_requests", "reviewed_by"],
      ["audit_logs", "actor_id"],
      ["notifications", "recipient_id"],
      ["chat_messages", "user_id"],
    ] as const) {
      const dangling = ownerScopedDanglingUserRows(db, table, column);
      if (dangling > 0) failures.push(`${ownerId}: ${table}.${column} rows without local user: ${dangling}`);
    }

    const timeClockServices = ownerScopedDanglingServiceRows(db, "time_clocks");
    if (timeClockServices > 0) failures.push(`${ownerId}: time_clocks.service_id rows without local service: ${timeClockServices}`);

    const replacementRequestServices = ownerScopedDanglingServiceRows(db, "replacement_requests", "requester_service_id");
    if (replacementRequestServices > 0) failures.push(`${ownerId}: replacement_requests.requester_service_id rows without local service: ${replacementRequestServices}`);

    const openShiftServices = ownerScopedDanglingServiceRows(db, "open_shifts");
    if (openShiftServices > 0) failures.push(`${ownerId}: open_shifts.service_id rows without local service: ${openShiftServices}`);

    const serviceTemplateProfiles = ownerScopedDanglingProfileRows(db, "service_templates");
    if (serviceTemplateProfiles > 0) failures.push(`${ownerId}: service_templates.profile_id rows without local staffing profile: ${serviceTemplateProfiles}`);

    const staffingScheduleProfiles = ownerScopedDanglingProfileRows(db, "staffing_schedule");
    if (staffingScheduleProfiles > 0) failures.push(`${ownerId}: staffing_schedule.profile_id rows without local staffing profile: ${staffingScheduleProfiles}`);

    const staffingTargetProfiles = ownerScopedDanglingProfileRows(db, "staffing_targets");
    if (staffingTargetProfiles > 0) failures.push(`${ownerId}: staffing_targets.profile_id rows without local staffing profile: ${staffingTargetProfiles}`);

    const staffingAnalysisCacheProfiles = ownerScopedDanglingProfileRows(db, "staffing_analysis_cache");
    if (staffingAnalysisCacheProfiles > 0) failures.push(`${ownerId}: staffing_analysis_cache.profile_id rows without local staffing profile: ${staffingAnalysisCacheProfiles}`);

    const serviceTemplateOverrideTemplates = ownerScopedDanglingTemplateRows(db, "service_template_overrides");
    if (serviceTemplateOverrideTemplates > 0) failures.push(`${ownerId}: service_template_overrides.template_id rows without local service template: ${serviceTemplateOverrideTemplates}`);

    for (const [table, column] of [
      ["replacement_requests", "candidate_ids"],
      ["replacement_requests", "rejected_candidate_ids"],
      ["open_shifts", "candidate_ids"],
      ["open_shifts", "rejected_candidate_ids"],
      ["open_shifts", "solicited_candidate_ids"],
    ] as const) {
      const result = ownerScopedDanglingJsonUserIds(db, table, column);
      if (result.dangling > 0) failures.push(`${ownerId}: ${table}.${column} JSON user ids without local user: ${result.dangling}`);
      if (result.malformed > 0) failures.push(`${ownerId}: ${table}.${column} malformed JSON arrays: ${result.malformed}`);
    }

    return {
      result: {
        ownerId,
        filePath,
        restaurants: tableExists(db, "restaurants") ? count(db, "SELECT COUNT(*) AS c FROM restaurants") : 0,
        users: tableExists(db, "users") ? count(db, "SELECT COUNT(*) AS c FROM users") : 0,
        restaurantMemberships: tableExists(db, "restaurant_memberships") ? count(db, "SELECT COUNT(*) AS c FROM restaurant_memberships") : 0,
        workerProfiles: tableExists(db, "worker_restaurant_profiles") ? count(db, "SELECT COUNT(*) AS c FROM worker_restaurant_profiles") : 0,
        workerShareAuthorizations: tableExists(db, "worker_share_authorizations") ? count(db, "SELECT COUNT(*) AS c FROM worker_share_authorizations") : 0,
        staffingProfiles: tableExists(db, "staffing_profiles") ? count(db, "SELECT COUNT(*) AS c FROM staffing_profiles") : 0,
        serviceTemplates: tableExists(db, "service_templates") ? count(db, "SELECT COUNT(*) AS c FROM service_templates") : 0,
        serviceTemplateOverrides: tableExists(db, "service_template_overrides") ? count(db, "SELECT COUNT(*) AS c FROM service_template_overrides") : 0,
        staffingSchedule: tableExists(db, "staffing_schedule") ? count(db, "SELECT COUNT(*) AS c FROM staffing_schedule") : 0,
        staffingTargets: tableExists(db, "staffing_targets") ? count(db, "SELECT COUNT(*) AS c FROM staffing_targets") : 0,
        staffingAnalysisCache: tableExists(db, "staffing_analysis_cache") ? count(db, "SELECT COUNT(*) AS c FROM staffing_analysis_cache") : 0,
        subRoleTrainingCosts: tableExists(db, "sub_role_training_costs") ? count(db, "SELECT COUNT(*) AS c FROM sub_role_training_costs") : 0,
        subRoleTrainingMoves: tableExists(db, "sub_role_training_moves") ? count(db, "SELECT COUNT(*) AS c FROM sub_role_training_moves") : 0,
        onboardingTokens: tableExists(db, "onboarding_tokens") ? count(db, "SELECT COUNT(*) AS c FROM onboarding_tokens") : 0,
        workerWeeklyHours: tableExists(db, "worker_weekly_hours") ? count(db, "SELECT COUNT(*) AS c FROM worker_weekly_hours") : 0,
        services: tableExists(db, "services") ? count(db, "SELECT COUNT(*) AS c FROM services") : 0,
        timeClocks: tableExists(db, "time_clocks") ? count(db, "SELECT COUNT(*) AS c FROM time_clocks") : 0,
        dailyRevenue: tableExists(db, "daily_revenue") ? count(db, "SELECT COUNT(*) AS c FROM daily_revenue") : 0,
        restaurantClosures: tableExists(db, "restaurant_closures") ? count(db, "SELECT COUNT(*) AS c FROM restaurant_closures") : 0,
        publishedWeeks: tableExists(db, "published_weeks") ? count(db, "SELECT COUNT(*) AS c FROM published_weeks") : 0,
        calendarEvents: tableExists(db, "calendar_events") ? count(db, "SELECT COUNT(*) AS c FROM calendar_events") : 0,
        workerAvailability: tableExists(db, "worker_availability") ? count(db, "SELECT COUNT(*) AS c FROM worker_availability") : 0,
        workerPreferredSchedule: tableExists(db, "worker_preferred_schedule") ? count(db, "SELECT COUNT(*) AS c FROM worker_preferred_schedule") : 0,
        workerRestrictions: tableExists(db, "worker_restrictions") ? count(db, "SELECT COUNT(*) AS c FROM worker_restrictions") : 0,
        emailRecipients: tableExists(db, "email_recipients") ? count(db, "SELECT COUNT(*) AS c FROM email_recipients") : 0,
        contractTemplates: tableExists(db, "contract_templates") ? count(db, "SELECT COUNT(*) AS c FROM contract_templates") : 0,
        weatherData: tableExists(db, "weather_data") ? count(db, "SELECT COUNT(*) AS c FROM weather_data") : 0,
        adminAlerts: tableExists(db, "admin_alerts") ? count(db, "SELECT COUNT(*) AS c FROM admin_alerts") : 0,
        holidayRequests: tableExists(db, "holiday_requests") ? count(db, "SELECT COUNT(*) AS c FROM holiday_requests") : 0,
        replacementRequests: tableExists(db, "replacement_requests") ? count(db, "SELECT COUNT(*) AS c FROM replacement_requests") : 0,
        openShifts: tableExists(db, "open_shifts") ? count(db, "SELECT COUNT(*) AS c FROM open_shifts") : 0,
        restrictionRequests: tableExists(db, "restriction_requests") ? count(db, "SELECT COUNT(*) AS c FROM restriction_requests") : 0,
        documents: tableExists(db, "documents") ? count(db, "SELECT COUNT(*) AS c FROM documents") : 0,
        auditLogs: tableExists(db, "audit_logs") ? count(db, "SELECT COUNT(*) AS c FROM audit_logs") : 0,
        notifications: tableExists(db, "notifications") ? count(db, "SELECT COUNT(*) AS c FROM notifications") : 0,
        chatMessages: tableExists(db, "chat_messages") ? count(db, "SELECT COUNT(*) AS c FROM chat_messages") : 0,
        cronRuns: tableExists(db, "cron_runs") ? count(db, "SELECT COUNT(*) AS c FROM cron_runs") : 0,
      },
      failures,
    };
  } finally {
    db.close();
  }
}

function readManifest(filePath: string) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Phase7CoreSnapshotManifest;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function verifyPhase7CoreSnapshotDirectory(directory: string): Phase7SnapshotVerification {
  const failures: string[] = [];
  const manifestPath = join(directory, PHASE7_CORE_SNAPSHOT_MANIFEST);
  const masterPath = join(directory, "master.sqlite");

  const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : new Error(`missing manifest file ${manifestPath}`);
  if (manifest instanceof Error) {
    return {
      directory,
      manifestPath,
      masterPath,
      master: {
        loginIdentities: 0,
        owners: 0,
        ownerMemberships: 0,
        ownerLegalAcceptances: 0,
        sessions: 0,
        notifications: 0,
        chatMessages: 0,
        cronRuns: 0,
      },
      checkedOwners: [],
      failures: [manifest.message],
    };
  }

  if (manifest.snapshotVersion !== PHASE7_CORE_SNAPSHOT_VERSION) {
    failures.push(`manifest: unsupported snapshotVersion ${manifest.snapshotVersion}`);
  }
  if (manifest.scope?.kind !== PHASE7_CORE_SNAPSHOT_KIND) {
    failures.push(`manifest: unsupported or missing snapshot scope ${manifest.scope?.kind ?? "missing"}`);
  }
  const scope = expectedCoreScope();
  failures.push(
    ...verifyExactList("scope.copiedOwnerTables", manifest.scope?.copiedOwnerTables, scope.copiedOwnerTables),
    ...verifyExactList("scope.remainingOwnerTables", manifest.scope?.remainingOwnerTables, scope.remainingOwnerTables),
    ...verifyExactList("scope.remainingSplitTables", manifest.scope?.remainingSplitTables, scope.remainingSplitTables),
  );
  if (manifest.masterPath !== masterPath) {
    failures.push(`manifest: masterPath mismatch ${manifest.masterPath}`);
  }
  failures.push(...verifyFingerprint(manifest, masterPath));

  if (!existsSync(masterPath)) {
    return {
      directory,
      manifestPath,
      masterPath,
      master: {
        loginIdentities: 0,
        owners: 0,
        ownerMemberships: 0,
        ownerLegalAcceptances: 0,
        sessions: 0,
        notifications: 0,
        chatMessages: 0,
        cronRuns: 0,
      },
      checkedOwners: [],
      failures: [...failures, `missing master file ${masterPath}`],
    };
  }

  const master = new Database(masterPath, { readonly: true });
  try {
    for (const table of ["login_identities", "owners", "owner_memberships", "owner_legal_acceptances", "sessions", "notifications", "chat_messages", "cron_runs"]) {
      if (!tableExists(master, table)) failures.push(`master: missing table ${table}`);
    }

    const masterColumns = tableExists(master, "owners") ? columnNames(master, "owners") : [];
    if (!masterColumns.includes("database_path")) failures.push("master: owners.database_path is missing");

    const ownerRows = tableExists(master, "owners")
      ? master.query("SELECT id, database_path FROM owners ORDER BY id").all() as OwnerLocationRow[]
      : [];
    const masterCounts = {
      loginIdentities: tableExists(master, "login_identities") ? count(master, "SELECT COUNT(*) AS c FROM login_identities") : 0,
      owners: tableExists(master, "owners") ? count(master, "SELECT COUNT(*) AS c FROM owners") : 0,
      ownerMemberships: tableExists(master, "owner_memberships") ? count(master, "SELECT COUNT(*) AS c FROM owner_memberships") : 0,
      ownerLegalAcceptances: tableExists(master, "owner_legal_acceptances") ? count(master, "SELECT COUNT(*) AS c FROM owner_legal_acceptances") : 0,
      sessions: tableExists(master, "sessions") ? count(master, "SELECT COUNT(*) AS c FROM sessions") : 0,
      notifications: tableExists(master, "notifications") ? count(master, "SELECT COUNT(*) AS c FROM notifications") : 0,
      chatMessages: tableExists(master, "chat_messages") ? count(master, "SELECT COUNT(*) AS c FROM chat_messages") : 0,
      cronRuns: tableExists(master, "cron_runs") ? count(master, "SELECT COUNT(*) AS c FROM cron_runs") : 0,
    };

    for (const [key, actual] of Object.entries(masterCounts)) {
      const expected = manifest.copied.master[key as keyof typeof manifest.copied.master];
      if (actual !== expected) failures.push(`master: ${key} count mismatch: ${actual} != ${expected}`);
    }

    const manifestOwnerIds = Object.keys(manifest.ownerPaths).sort();
    const masterOwnerIds = ownerRows.map((row) => row.id).sort();
    if (JSON.stringify(manifestOwnerIds) !== JSON.stringify(masterOwnerIds)) {
      failures.push(`manifest: ownerPaths do not match master owners`);
    }

    const ownerPathById = new Map(ownerRows.map((row) => [row.id, row.database_path] as const));
    const ownerUserIdsById = new Map<string, Set<string>>();
    const ownerRestaurantIdsById = new Map<string, Set<string>>();

    const checkedOwners = ownerRows.map((row) => {
      const manifestPathForOwner = manifest.ownerPaths[row.id];
      if (manifestPathForOwner !== row.database_path) {
        failures.push(`${row.id}: manifest owner path does not match master database_path`);
      }
      failures.push(...verifyFingerprint(manifest, row.database_path));
      const check = verifyOwnerDataFile(row.id, row.database_path);
      failures.push(...check.failures);

      const expectedOwnerUserIds = tableExists(master, "owner_memberships")
        ? strings(master, "SELECT user_id AS value FROM owner_memberships WHERE owner_id = ? ORDER BY user_id", [row.id])
        : [];
      const actualOwnerUserIds = ownerDataUserIds(row.database_path);
      ownerUserIdsById.set(row.id, new Set(actualOwnerUserIds));
      const userDiff = diffSortedIds(actualOwnerUserIds, expectedOwnerUserIds);
      if (userDiff.missing.length > 0 || userDiff.extra.length > 0) {
        failures.push(`${row.id}: owner-local users do not match master owner_memberships; missing [${formatIdList(userDiff.missing)}], extra [${formatIdList(userDiff.extra)}]`);
      }
      ownerRestaurantIdsById.set(row.id, new Set(ownerDataRestaurantIds(row.database_path)));

      const expected = manifest.copied.owners.find((owner) => owner.ownerId === row.id);
      if (!expected) {
        failures.push(`${row.id}: missing copied-count manifest entry`);
      } else {
        for (const [key, actual] of Object.entries({
          restaurants: check.result.restaurants,
          users: check.result.users,
          restaurantMemberships: check.result.restaurantMemberships,
          workerProfiles: check.result.workerProfiles,
          workerShareAuthorizations: check.result.workerShareAuthorizations,
          staffingProfiles: check.result.staffingProfiles,
          serviceTemplates: check.result.serviceTemplates,
          serviceTemplateOverrides: check.result.serviceTemplateOverrides,
          staffingSchedule: check.result.staffingSchedule,
          staffingTargets: check.result.staffingTargets,
          staffingAnalysisCache: check.result.staffingAnalysisCache,
          subRoleTrainingCosts: check.result.subRoleTrainingCosts,
          subRoleTrainingMoves: check.result.subRoleTrainingMoves,
          onboardingTokens: check.result.onboardingTokens,
          workerWeeklyHours: check.result.workerWeeklyHours,
          services: check.result.services,
          timeClocks: check.result.timeClocks,
          dailyRevenue: check.result.dailyRevenue,
          restaurantClosures: check.result.restaurantClosures,
          publishedWeeks: check.result.publishedWeeks,
          calendarEvents: check.result.calendarEvents,
          workerAvailability: check.result.workerAvailability,
          workerPreferredSchedule: check.result.workerPreferredSchedule,
          workerRestrictions: check.result.workerRestrictions,
          emailRecipients: check.result.emailRecipients,
          contractTemplates: check.result.contractTemplates,
          weatherData: check.result.weatherData,
          adminAlerts: check.result.adminAlerts,
          holidayRequests: check.result.holidayRequests,
          replacementRequests: check.result.replacementRequests,
          openShifts: check.result.openShifts,
          restrictionRequests: check.result.restrictionRequests,
          documents: check.result.documents,
          auditLogs: check.result.auditLogs,
          notifications: check.result.notifications,
          chatMessages: check.result.chatMessages,
          cronRuns: check.result.cronRuns,
        })) {
          const expectedCount = expected[key as keyof typeof expected];
          if (actual !== expectedCount) failures.push(`${row.id}: ${key} count mismatch: ${actual} != ${expectedCount}`);
        }
      }
      return check.result;
    });

    if (tableExists(master, "owner_memberships")) {
      const danglingOwnerMemberships = count(master, `
        SELECT COUNT(*) AS c
        FROM owner_memberships om
        LEFT JOIN owners o ON o.id = om.owner_id
        LEFT JOIN login_identities li ON li.id = om.user_id
        WHERE o.id IS NULL OR li.id IS NULL
      `);
      if (danglingOwnerMemberships > 0) failures.push(`master: dangling owner memberships: ${danglingOwnerMemberships}`);
    }

    if (tableExists(master, "owner_legal_acceptances")) {
      const danglingOwnerLegalAcceptances = count(master, `
        SELECT COUNT(*) AS c
        FROM owner_legal_acceptances ola
        LEFT JOIN owners o ON o.id = ola.owner_id
        LEFT JOIN login_identities li ON li.id = ola.user_id
        WHERE o.id IS NULL OR li.id IS NULL
      `);
      if (danglingOwnerLegalAcceptances > 0) failures.push(`master: dangling owner legal acceptances: ${danglingOwnerLegalAcceptances}`);
    }

    if (tableExists(master, "login_identities") && tableExists(master, "owner_memberships")) {
      const ownerlessLoginIdentities = count(master, `
        SELECT COUNT(*) AS c
        FROM login_identities li
        LEFT JOIN owner_memberships om ON om.user_id = li.id
        WHERE om.user_id IS NULL
      `);
      if (ownerlessLoginIdentities > 0) failures.push(`master: login identities without owner membership: ${ownerlessLoginIdentities}`);
    }

    if (tableExists(master, "sessions")) {
      const danglingSessions = count(master, `
        SELECT COUNT(*) AS c
        FROM sessions s
        LEFT JOIN login_identities li ON li.id = s.user_id
        LEFT JOIN owners o ON o.id = s.active_owner_id
        WHERE li.id IS NULL
           OR (s.active_owner_id IS NOT NULL AND o.id IS NULL)
      `);
      if (danglingSessions > 0) failures.push(`master: dangling sessions: ${danglingSessions}`);

      const sessionRows = master.query(`
        SELECT id, user_id, active_owner_id, active_restaurant_id
        FROM sessions
        WHERE active_owner_id IS NOT NULL OR active_restaurant_id IS NOT NULL
        ORDER BY id
      `).all() as SessionContextRow[];
      for (const session of sessionRows) {
        if (session.active_restaurant_id && !session.active_owner_id) {
          failures.push(`master: session ${session.id} has active_restaurant_id without active_owner_id`);
          continue;
        }
        if (!session.active_owner_id) continue;

        const ownerPath = ownerPathById.get(session.active_owner_id);
        if (!ownerPath) continue;

        const ownerUsers = ownerUserIdsById.get(session.active_owner_id) ?? new Set(ownerDataUserIds(ownerPath));
        if (!ownerUsers.has(session.user_id)) {
          failures.push(`master: session ${session.id} user ${session.user_id} is not a member of active owner ${session.active_owner_id}`);
        }

        if (session.active_restaurant_id) {
          const ownerRestaurants = ownerRestaurantIdsById.get(session.active_owner_id) ?? new Set(ownerDataRestaurantIds(ownerPath));
          if (!ownerRestaurants.has(session.active_restaurant_id)) {
            failures.push(`master: session ${session.id} active restaurant ${session.active_restaurant_id} is missing from owner ${session.active_owner_id}`);
          }
        }
      }
    }

    return {
      directory,
      manifestPath,
      masterPath,
      master: masterCounts,
      checkedOwners,
      failures,
    };
  } finally {
    master.close();
  }
}
