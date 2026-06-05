import type { Database } from "bun:sqlite";

export type Phase7OwnerRowCounts = {
  ownerId: string;
  restaurants: number;
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
};

export type Phase7DryRunSummary = {
  master: {
    loginIdentities: number;
    owners: number;
    ownerMemberships: number;
    ownerLegalAcceptances: number;
    sessions: number;
  };
  owners: Phase7OwnerRowCounts[];
  splitTables: {
    users: number;
    legalAcceptances: number;
    notifications: number;
    chatMessages: number;
    cronRuns: number;
  };
  splitSchemaIssues: Array<{
    table: string;
    missingColumns: string[];
    reason: string;
  }>;
  splitScopeGaps: Array<{
    table: string;
    issue: string;
    count: number;
  }>;
  failures: string[];
};

function count(db: Database, sql: string, params: Array<string | number | null> = []): number {
  const row = db.query(sql).get(...params) as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

function hasTable(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

function tableColumns(db: Database, table: string): Set<string> {
  if (!hasTable(db, table)) return new Set();
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

export function collectPhase7SplitSchemaIssues(db: Database): Phase7DryRunSummary["splitSchemaIssues"] {
  const requirements = [
    {
      table: "notifications",
      columns: ["owner_id", "restaurant_id"],
      reason: "needed to separate master billing/global notices from owner-local restaurant delivery attempts",
    },
    {
      table: "chat_messages",
      columns: ["owner_id", "restaurant_id", "context_kind"],
      reason: "needed to separate pre-context routing messages from owner-local restaurant tool transcripts",
    },
    {
      table: "cron_runs",
      columns: ["owner_id", "scope"],
      reason: "needed to separate fleet orchestration attempts from owner-local job attempts",
    },
  ];

  return requirements
    .filter((requirement) => hasTable(db, requirement.table))
    .map((requirement) => {
      const columns = tableColumns(db, requirement.table);
      return {
        table: requirement.table,
        missingColumns: requirement.columns.filter((column) => !columns.has(column)),
        reason: requirement.reason,
      };
    })
    .filter((issue) => issue.missingColumns.length > 0);
}

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const tableColumnSet = tableColumns(db, table);
  return columns.every((column) => tableColumnSet.has(column));
}

function pushGap(gaps: Phase7DryRunSummary["splitScopeGaps"], table: string, issue: string, value: number) {
  if (value > 0) gaps.push({ table, issue, count: value });
}

export function collectPhase7SplitScopeGaps(db: Database): Phase7DryRunSummary["splitScopeGaps"] {
  const gaps: Phase7DryRunSummary["splitScopeGaps"] = [];

  if (hasColumns(db, "notifications", ["owner_id", "restaurant_id", "type"])) {
    pushGap(gaps, "notifications", "missing_owner_id", count(db, "SELECT COUNT(*) AS c FROM notifications WHERE owner_id IS NULL"));
    pushGap(gaps, "notifications", "restaurant_scoped_without_restaurant_id", count(db, `
      SELECT COUNT(*) AS c
      FROM notifications
      WHERE restaurant_id IS NULL
        AND type NOT IN ('trial_ending', 'payment_failed', 'subscription_cancelled')
    `));
  }

  if (hasColumns(db, "chat_messages", ["owner_id", "restaurant_id", "context_kind"])) {
    pushGap(gaps, "chat_messages", "missing_context_kind", count(db, "SELECT COUNT(*) AS c FROM chat_messages WHERE context_kind IS NULL"));
    pushGap(gaps, "chat_messages", "restaurant_context_without_owner_id", count(db, `
      SELECT COUNT(*) AS c
      FROM chat_messages
      WHERE context_kind = 'restaurant_context'
        AND owner_id IS NULL
    `));
    pushGap(gaps, "chat_messages", "restaurant_context_without_restaurant_id", count(db, `
      SELECT COUNT(*) AS c
      FROM chat_messages
      WHERE context_kind = 'restaurant_context'
        AND restaurant_id IS NULL
    `));
  }

  if (hasColumns(db, "cron_runs", ["owner_id", "scope"])) {
    pushGap(gaps, "cron_runs", "missing_scope", count(db, "SELECT COUNT(*) AS c FROM cron_runs WHERE scope IS NULL"));
    pushGap(gaps, "cron_runs", "owner_scope_without_owner_id", count(db, `
      SELECT COUNT(*) AS c
      FROM cron_runs
      WHERE scope = 'owner'
        AND owner_id IS NULL
    `));
  }

  return gaps;
}

export function collectPhase7DryRunSummary(db: Database): Phase7DryRunSummary {
  const requiredTables = [
    "owners",
    "restaurants",
    "users",
    "owner_memberships",
    "restaurant_memberships",
    "worker_restaurant_profiles",
    "worker_share_authorizations",
    "staffing_profiles",
    "service_templates",
    "service_template_overrides",
    "staffing_schedule",
    "staffing_targets",
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
  ];
  const failures = requiredTables
    .filter((table) => !hasTable(db, table))
    .map((table) => `missing table: ${table}`);

  if (failures.length > 0) {
    return {
      master: {
        loginIdentities: 0,
        owners: 0,
        ownerMemberships: 0,
        ownerLegalAcceptances: 0,
        sessions: 0,
      },
      owners: [],
      splitTables: {
        users: 0,
        legalAcceptances: 0,
        notifications: 0,
        chatMessages: 0,
        cronRuns: 0,
      },
      splitSchemaIssues: collectPhase7SplitSchemaIssues(db),
      splitScopeGaps: collectPhase7SplitScopeGaps(db),
      failures,
    };
  }

  const owners = db.query("SELECT id FROM owners ORDER BY id").all() as Array<{ id: string }>;
  const ownerRows = owners.map(({ id }) => ({
    ownerId: id,
    restaurants: count(db, "SELECT COUNT(*) AS c FROM restaurants WHERE owner_id = ?", [id]),
    restaurantMemberships: count(db, `
      SELECT COUNT(*) AS c
      FROM restaurant_memberships rm
      INNER JOIN restaurants r ON r.id = rm.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    workerProfiles: count(db, `
      SELECT COUNT(*) AS c
      FROM worker_restaurant_profiles wrp
      INNER JOIN restaurants r ON r.id = wrp.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    workerShareAuthorizations: count(db, `
      SELECT COUNT(*) AS c
      FROM worker_share_authorizations wsa
      WHERE wsa.owner_id = ?
    `, [id]),
    staffingProfiles: count(db, `
      SELECT COUNT(*) AS c
      FROM staffing_profiles sp
      INNER JOIN restaurants r ON r.id = sp.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    serviceTemplates: count(db, `
      SELECT COUNT(*) AS c
      FROM service_templates st
      INNER JOIN restaurants r ON r.id = st.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    serviceTemplateOverrides: count(db, `
      SELECT COUNT(*) AS c
      FROM service_template_overrides sto
      INNER JOIN service_templates st ON st.id = sto.template_id
      INNER JOIN restaurants r ON r.id = st.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    staffingSchedule: count(db, `
      SELECT COUNT(*) AS c
      FROM staffing_schedule ss
      INNER JOIN restaurants r ON r.id = ss.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    staffingTargets: count(db, `
      SELECT COUNT(*) AS c
      FROM staffing_targets st
      INNER JOIN restaurants r ON r.id = st.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    staffingAnalysisCache: hasTable(db, "staffing_analysis_cache") ? count(db, `
      SELECT COUNT(*) AS c
      FROM staffing_analysis_cache sac
      INNER JOIN restaurants r ON r.id = sac.restaurant_id
      WHERE r.owner_id = ?
    `, [id]) : 0,
    subRoleTrainingCosts: count(db, `
      SELECT COUNT(*) AS c
      FROM sub_role_training_costs srtc
      INNER JOIN restaurants r ON r.id = srtc.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    subRoleTrainingMoves: count(db, `
      SELECT COUNT(*) AS c
      FROM sub_role_training_moves srtm
      INNER JOIN restaurants r ON r.id = srtm.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    onboardingTokens: count(db, `
      SELECT COUNT(*) AS c
      FROM onboarding_tokens ot
      INNER JOIN restaurants r ON r.id = ot.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    workerWeeklyHours: count(db, `
      SELECT COUNT(*) AS c
      FROM worker_weekly_hours wwh
      INNER JOIN owner_memberships om ON om.user_id = wwh.worker_id
      WHERE om.owner_id = ?
    `, [id]),
    services: count(db, `
      SELECT COUNT(*) AS c
      FROM services s
      INNER JOIN restaurants r ON r.id = s.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    timeClocks: count(db, `
      SELECT COUNT(*) AS c
      FROM time_clocks tc
      INNER JOIN restaurants r ON r.id = tc.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    dailyRevenue: count(db, `
      SELECT COUNT(*) AS c
      FROM daily_revenue dr
      INNER JOIN restaurants r ON r.id = dr.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    restaurantClosures: count(db, `
      SELECT COUNT(*) AS c
      FROM restaurant_closures rc
      INNER JOIN restaurants r ON r.id = rc.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    publishedWeeks: count(db, `
      SELECT COUNT(*) AS c
      FROM published_weeks pw
      INNER JOIN restaurants r ON r.id = pw.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    calendarEvents: count(db, `
      SELECT COUNT(*) AS c
      FROM calendar_events ce
      INNER JOIN restaurants r ON r.id = ce.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    workerAvailability: count(db, `
      SELECT COUNT(*) AS c
      FROM worker_availability wa
      INNER JOIN restaurants r ON r.id = wa.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    workerPreferredSchedule: count(db, `
      SELECT COUNT(*) AS c
      FROM worker_preferred_schedule wps
      INNER JOIN restaurants r ON r.id = wps.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    workerRestrictions: count(db, `
      SELECT COUNT(*) AS c
      FROM worker_restrictions wr
      INNER JOIN restaurants r ON r.id = wr.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    emailRecipients: count(db, `
      SELECT COUNT(*) AS c
      FROM email_recipients er
      INNER JOIN restaurants r ON r.id = er.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    contractTemplates: count(db, `
      SELECT COUNT(*) AS c
      FROM contract_templates ct
      INNER JOIN restaurants r ON r.id = ct.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    weatherData: count(db, `
      SELECT COUNT(*) AS c
      FROM weather_data wd
      INNER JOIN restaurants r ON r.id = wd.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    adminAlerts: count(db, `
      SELECT COUNT(*) AS c
      FROM admin_alerts aa
      INNER JOIN restaurants r ON r.id = aa.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    holidayRequests: count(db, `
      SELECT COUNT(*) AS c
      FROM holiday_requests hr
      INNER JOIN restaurants r ON r.id = hr.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    replacementRequests: count(db, `
      SELECT COUNT(*) AS c
      FROM replacement_requests rr
      INNER JOIN restaurants r ON r.id = rr.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    openShifts: count(db, `
      SELECT COUNT(*) AS c
      FROM open_shifts os
      INNER JOIN restaurants r ON r.id = os.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    restrictionRequests: count(db, `
      SELECT COUNT(*) AS c
      FROM restriction_requests rr
      INNER JOIN restaurants r ON r.id = rr.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    documents: count(db, `
      SELECT COUNT(*) AS c
      FROM documents d
      INNER JOIN restaurants r ON r.id = d.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
    auditLogs: count(db, `
      SELECT COUNT(*) AS c
      FROM audit_logs a
      INNER JOIN restaurants r ON r.id = a.restaurant_id
      WHERE r.owner_id = ?
    `, [id]),
  }));

  const restaurantsWithoutOwner = count(db, "SELECT COUNT(*) AS c FROM restaurants WHERE owner_id IS NULL");
  if (restaurantsWithoutOwner > 0) failures.push(`restaurants_without_owner: ${restaurantsWithoutOwner}`);

  const ownerlessServices = count(db, `
    SELECT COUNT(*) AS c
    FROM services s
    LEFT JOIN restaurants r ON r.id = s.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessServices > 0) failures.push(`services_without_owner: ${ownerlessServices}`);

  const ownerlessWorkerShareAuthorizations = count(db, `
    SELECT COUNT(*) AS c
    FROM worker_share_authorizations wsa
    LEFT JOIN owners o ON o.id = wsa.owner_id
    WHERE o.id IS NULL
  `);
  if (ownerlessWorkerShareAuthorizations > 0) failures.push(`worker_share_authorizations_without_owner: ${ownerlessWorkerShareAuthorizations}`);

  const mismatchedWorkerShareAuthorizations = count(db, `
    SELECT COUNT(*) AS c
    FROM worker_share_authorizations wsa
    LEFT JOIN owners o ON o.id = wsa.owner_id
    LEFT JOIN restaurants source ON source.id = wsa.source_restaurant_id
    LEFT JOIN restaurants target ON target.id = wsa.target_restaurant_id
    WHERE o.id IS NOT NULL
      AND (
        source.owner_id IS NULL
        OR target.owner_id IS NULL
        OR source.owner_id != wsa.owner_id
        OR target.owner_id != wsa.owner_id
      )
  `);
  if (mismatchedWorkerShareAuthorizations > 0) failures.push(`worker_share_authorizations_with_mismatched_owner: ${mismatchedWorkerShareAuthorizations}`);

  for (const [table, label] of [
    ["staffing_profiles", "staffing_profiles_without_owner"],
    ["service_templates", "service_templates_without_owner"],
    ["staffing_schedule", "staffing_schedule_without_owner"],
    ["staffing_targets", "staffing_targets_without_owner"],
    ["staffing_analysis_cache", "staffing_analysis_cache_without_owner"],
    ["sub_role_training_costs", "sub_role_training_costs_without_owner"],
    ["sub_role_training_moves", "sub_role_training_moves_without_owner"],
  ] as const) {
    if (!hasTable(db, table)) continue;
    const ownerlessRows = count(db, `
      SELECT COUNT(*) AS c
      FROM ${table} child
      LEFT JOIN restaurants r ON r.id = child.restaurant_id
      WHERE r.owner_id IS NULL
    `);
    if (ownerlessRows > 0) failures.push(`${label}: ${ownerlessRows}`);
  }

  const ownerlessServiceTemplateOverrides = count(db, `
    SELECT COUNT(*) AS c
    FROM service_template_overrides sto
    LEFT JOIN service_templates st ON st.id = sto.template_id
    LEFT JOIN restaurants r ON r.id = st.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessServiceTemplateOverrides > 0) failures.push(`service_template_overrides_without_owner: ${ownerlessServiceTemplateOverrides}`);

  const ownerlessOnboardingTokens = count(db, `
    SELECT COUNT(*) AS c
    FROM onboarding_tokens ot
    LEFT JOIN restaurants r ON r.id = ot.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessOnboardingTokens > 0) failures.push(`onboarding_tokens_without_owner: ${ownerlessOnboardingTokens}`);

  const ownerlessWorkerWeeklyHours = count(db, `
    SELECT COUNT(*) AS c
    FROM worker_weekly_hours wwh
    LEFT JOIN owner_memberships om ON om.user_id = wwh.worker_id
    WHERE om.user_id IS NULL
  `);
  if (ownerlessWorkerWeeklyHours > 0) failures.push(`worker_weekly_hours_without_owner_membership: ${ownerlessWorkerWeeklyHours}`);

  if (hasTable(db, "legal_acceptances")) {
    const ownerlessLegalAcceptances = count(db, `
      SELECT COUNT(*) AS c
      FROM legal_acceptances la
      LEFT JOIN owners o ON o.id = la.owner_id
      WHERE la.owner_id IS NULL
         OR o.id IS NULL
    `);
    if (ownerlessLegalAcceptances > 0) failures.push(`legal_acceptances_without_owner: ${ownerlessLegalAcceptances}`);
  }

  const ownerlessDocuments = count(db, `
    SELECT COUNT(*) AS c
    FROM documents d
    LEFT JOIN restaurants r ON r.id = d.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessDocuments > 0) failures.push(`documents_without_owner: ${ownerlessDocuments}`);

  const ownerlessTimeClocks = count(db, `
    SELECT COUNT(*) AS c
    FROM time_clocks tc
    LEFT JOIN restaurants r ON r.id = tc.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessTimeClocks > 0) failures.push(`time_clocks_without_owner: ${ownerlessTimeClocks}`);

  const ownerlessDailyRevenue = count(db, `
    SELECT COUNT(*) AS c
    FROM daily_revenue dr
    LEFT JOIN restaurants r ON r.id = dr.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessDailyRevenue > 0) failures.push(`daily_revenue_without_owner: ${ownerlessDailyRevenue}`);

  const ownerlessRestaurantClosures = count(db, `
    SELECT COUNT(*) AS c
    FROM restaurant_closures rc
    LEFT JOIN restaurants r ON r.id = rc.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessRestaurantClosures > 0) failures.push(`restaurant_closures_without_owner: ${ownerlessRestaurantClosures}`);

  const ownerlessPublishedWeeks = count(db, `
    SELECT COUNT(*) AS c
    FROM published_weeks pw
    LEFT JOIN restaurants r ON r.id = pw.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessPublishedWeeks > 0) failures.push(`published_weeks_without_owner: ${ownerlessPublishedWeeks}`);

  const ownerlessCalendarEvents = count(db, `
    SELECT COUNT(*) AS c
    FROM calendar_events ce
    LEFT JOIN restaurants r ON r.id = ce.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessCalendarEvents > 0) failures.push(`calendar_events_without_owner: ${ownerlessCalendarEvents}`);

  const ownerlessWorkerAvailability = count(db, `
    SELECT COUNT(*) AS c
    FROM worker_availability wa
    LEFT JOIN restaurants r ON r.id = wa.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessWorkerAvailability > 0) failures.push(`worker_availability_without_owner: ${ownerlessWorkerAvailability}`);

  const ownerlessWorkerPreferredSchedule = count(db, `
    SELECT COUNT(*) AS c
    FROM worker_preferred_schedule wps
    LEFT JOIN restaurants r ON r.id = wps.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessWorkerPreferredSchedule > 0) failures.push(`worker_preferred_schedule_without_owner: ${ownerlessWorkerPreferredSchedule}`);

  const ownerlessWorkerRestrictions = count(db, `
    SELECT COUNT(*) AS c
    FROM worker_restrictions wr
    LEFT JOIN restaurants r ON r.id = wr.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessWorkerRestrictions > 0) failures.push(`worker_restrictions_without_owner: ${ownerlessWorkerRestrictions}`);

  const ownerlessEmailRecipients = count(db, `
    SELECT COUNT(*) AS c
    FROM email_recipients er
    LEFT JOIN restaurants r ON r.id = er.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessEmailRecipients > 0) failures.push(`email_recipients_without_owner: ${ownerlessEmailRecipients}`);

  const ownerlessContractTemplates = count(db, `
    SELECT COUNT(*) AS c
    FROM contract_templates ct
    LEFT JOIN restaurants r ON r.id = ct.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessContractTemplates > 0) failures.push(`contract_templates_without_owner: ${ownerlessContractTemplates}`);

  const ownerlessWeatherData = count(db, `
    SELECT COUNT(*) AS c
    FROM weather_data wd
    LEFT JOIN restaurants r ON r.id = wd.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessWeatherData > 0) failures.push(`weather_data_without_owner: ${ownerlessWeatherData}`);

  const ownerlessAdminAlerts = count(db, `
    SELECT COUNT(*) AS c
    FROM admin_alerts aa
    LEFT JOIN restaurants r ON r.id = aa.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessAdminAlerts > 0) failures.push(`admin_alerts_without_owner: ${ownerlessAdminAlerts}`);

  const ownerlessHolidayRequests = count(db, `
    SELECT COUNT(*) AS c
    FROM holiday_requests hr
    LEFT JOIN restaurants r ON r.id = hr.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessHolidayRequests > 0) failures.push(`holiday_requests_without_owner: ${ownerlessHolidayRequests}`);

  const ownerlessReplacementRequests = count(db, `
    SELECT COUNT(*) AS c
    FROM replacement_requests rr
    LEFT JOIN restaurants r ON r.id = rr.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessReplacementRequests > 0) failures.push(`replacement_requests_without_owner: ${ownerlessReplacementRequests}`);

  const ownerlessOpenShifts = count(db, `
    SELECT COUNT(*) AS c
    FROM open_shifts os
    LEFT JOIN restaurants r ON r.id = os.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessOpenShifts > 0) failures.push(`open_shifts_without_owner: ${ownerlessOpenShifts}`);

  const ownerlessRestrictionRequests = count(db, `
    SELECT COUNT(*) AS c
    FROM restriction_requests rr
    LEFT JOIN restaurants r ON r.id = rr.restaurant_id
    WHERE r.owner_id IS NULL
  `);
  if (ownerlessRestrictionRequests > 0) failures.push(`restriction_requests_without_owner: ${ownerlessRestrictionRequests}`);

  return {
    master: {
      loginIdentities: count(db, "SELECT COUNT(*) AS c FROM users"),
      owners: count(db, "SELECT COUNT(*) AS c FROM owners"),
      ownerMemberships: count(db, "SELECT COUNT(*) AS c FROM owner_memberships"),
      ownerLegalAcceptances: hasTable(db, "legal_acceptances") ? count(db, "SELECT COUNT(*) AS c FROM legal_acceptances WHERE owner_id IS NOT NULL") : 0,
      sessions: hasTable(db, "sessions") ? count(db, "SELECT COUNT(*) AS c FROM sessions") : 0,
    },
    owners: ownerRows,
    splitTables: {
      users: count(db, "SELECT COUNT(*) AS c FROM users"),
      legalAcceptances: hasTable(db, "legal_acceptances") ? count(db, "SELECT COUNT(*) AS c FROM legal_acceptances") : 0,
      notifications: hasTable(db, "notifications") ? count(db, "SELECT COUNT(*) AS c FROM notifications") : 0,
      chatMessages: hasTable(db, "chat_messages") ? count(db, "SELECT COUNT(*) AS c FROM chat_messages") : 0,
      cronRuns: hasTable(db, "cron_runs") ? count(db, "SELECT COUNT(*) AS c FROM cron_runs") : 0,
    },
    splitSchemaIssues: collectPhase7SplitSchemaIssues(db),
    splitScopeGaps: collectPhase7SplitScopeGaps(db),
    failures,
  };
}
