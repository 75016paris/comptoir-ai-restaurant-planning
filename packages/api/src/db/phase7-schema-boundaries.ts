export type Phase7SchemaTarget = "master" | "owner" | "split";

export type Phase7TableBoundary = {
  table: string;
  exportName: string;
  target: Phase7SchemaTarget;
  reason: string;
};

export const phase7TableBoundaries = [
  {
    table: "owners",
    exportName: "owners",
    target: "master",
    reason: "Billing, legal account state, and database routing belong to the global control plane.",
  },
  {
    table: "owner_memberships",
    exportName: "ownerMemberships",
    target: "master",
    reason: "Login-time routing needs to know which owners a user can access before opening owner data.",
  },
  {
    table: "users",
    exportName: "users",
    target: "split",
    reason: "Login identity, email, password hash, sessions, and account status move to master; restaurant employment fields move to owner data.",
  },
  {
    table: "sessions",
    exportName: "sessions",
    target: "master",
    reason: "Sessions must resolve a user and active owner before any owner database is opened.",
  },
  {
    table: "password_reset_tokens",
    exportName: "passwordResetTokens",
    target: "master",
    reason: "Password reset is a global login-identity workflow.",
  },
  {
    table: "pending_registrations",
    exportName: "pendingRegistrations",
    target: "master",
    reason: "Registration and Stripe checkout create the owner account before an owner database exists.",
  },
  {
    table: "legal_acceptances",
    exportName: "legalAcceptances",
    target: "split",
    reason: "Owner/admin terms are master state; restaurant-specific or worker notices must stay with the owner data that produced them.",
  },
  {
    table: "whatsapp_context_sessions",
    exportName: "whatsappContextSessions",
    target: "master",
    reason: "Ambiguous phone routing must select owner and restaurant context before opening owner data.",
  },
  {
    table: "restaurants",
    exportName: "restaurants",
    target: "owner",
    reason: "Restaurants are operational tenant data owned by one owner database.",
  },
  {
    table: "restaurant_memberships",
    exportName: "restaurantMemberships",
    target: "owner",
    reason: "Restaurant role and permission scope is owner-local operational data.",
  },
  {
    table: "worker_restaurant_profiles",
    exportName: "workerRestaurantProfiles",
    target: "owner",
    reason: "Employment, payroll, scheduling profile, and worker preference data are owner-local.",
  },
  {
    table: "worker_share_authorizations",
    exportName: "workerShareAuthorizations",
    target: "owner",
    reason: "Worker sharing is explicitly same-owner only, so it stays inside one owner database.",
  },
  {
    table: "documents",
    exportName: "documents",
    target: "owner",
    reason: "Document metadata is restaurant-scoped and must not cross owner database boundaries.",
  },
  {
    table: "time_clocks",
    exportName: "timeClocks",
    target: "owner",
    reason: "Pointage is restaurant operational data.",
  },
  {
    table: "daily_revenue",
    exportName: "dailyRevenue",
    target: "owner",
    reason: "Revenue inputs are restaurant operational data.",
  },
  {
    table: "services",
    exportName: "services",
    target: "owner",
    reason: "Schedules and worked services are restaurant operational data.",
  },
  {
    table: "replacement_requests",
    exportName: "replacementRequests",
    target: "owner",
    reason: "Replacement workflows are restaurant operational data.",
  },
  {
    table: "open_shifts",
    exportName: "openShifts",
    target: "owner",
    reason: "Open shifts are restaurant operational data.",
  },
  {
    table: "holiday_requests",
    exportName: "holidayRequests",
    target: "owner",
    reason: "Leave and sick-note workflows are restaurant-scoped employment data.",
  },
  {
    table: "notifications",
    exportName: "notifications",
    target: "split",
    reason: "Restaurant notifications stay owner-local; billing and global account notices need a master outbox.",
  },
  {
    table: "admin_alerts",
    exportName: "adminAlerts",
    target: "owner",
    reason: "In-app alerts are tied to a restaurant and active owner data.",
  },
  {
    table: "restaurant_closures",
    exportName: "restaurantClosures",
    target: "owner",
    reason: "Closures are restaurant operational settings.",
  },
  {
    table: "service_templates",
    exportName: "serviceTemplates",
    target: "owner",
    reason: "Service templates are restaurant scheduling configuration.",
  },
  {
    table: "service_template_overrides",
    exportName: "serviceTemplateOverrides",
    target: "owner",
    reason: "Template overrides depend on owner-local service templates.",
  },
  {
    table: "worker_availability",
    exportName: "workerAvailability",
    target: "owner",
    reason: "Worker availability is restaurant-scoped scheduling data.",
  },
  {
    table: "staffing_profiles",
    exportName: "staffingProfiles",
    target: "owner",
    reason: "Staffing profiles are restaurant optimizer configuration.",
  },
  {
    table: "staffing_schedule",
    exportName: "staffingSchedule",
    target: "owner",
    reason: "Staffing schedule selections are restaurant optimizer configuration.",
  },
  {
    table: "staffing_targets",
    exportName: "staffingTargets",
    target: "owner",
    reason: "Staffing targets are restaurant optimizer configuration.",
  },
  {
    table: "calendar_events",
    exportName: "calendarEvents",
    target: "owner",
    reason: "Calendar events are computed per restaurant location and settings.",
  },
  {
    table: "onboarding_tokens",
    exportName: "onboardingTokens",
    target: "owner",
    reason: "Dossier links are restaurant-bound worker onboarding flows.",
  },
  {
    table: "chat_messages",
    exportName: "chatMessages",
    target: "split",
    reason: "Pre-context routing messages need master state; restaurant tool transcripts belong to owner data.",
  },
  {
    table: "worker_restrictions",
    exportName: "workerRestrictions",
    target: "owner",
    reason: "Worker restrictions are restaurant-scoped scheduling data.",
  },
  {
    table: "restriction_requests",
    exportName: "restrictionRequests",
    target: "owner",
    reason: "Availability change requests are restaurant-scoped scheduling workflows.",
  },
  {
    table: "worker_preferred_schedule",
    exportName: "workerPreferredSchedule",
    target: "owner",
    reason: "Preferred schedules are restaurant-scoped worker preferences.",
  },
  {
    table: "audit_logs",
    exportName: "auditLogs",
    target: "owner",
    reason: "Operational audit logs must export, restore, and delete with the owner data they describe.",
  },
  {
    table: "weather_data",
    exportName: "weatherData",
    target: "owner",
    reason: "Weather cache is restaurant-location data.",
  },
  {
    table: "contract_templates",
    exportName: "contractTemplates",
    target: "owner",
    reason: "Contract templates are restaurant HR configuration.",
  },
  {
    table: "published_weeks",
    exportName: "publishedWeeks",
    target: "owner",
    reason: "Published weeks are restaurant scheduling state.",
  },
  {
    table: "email_recipients",
    exportName: "emailRecipients",
    target: "owner",
    reason: "Extra recipients are restaurant notification configuration.",
  },
  {
    table: "worker_weekly_hours",
    exportName: "workerWeeklyHours",
    target: "owner",
    reason: "Weekly hours are derived from owner-local services and compliance state.",
  },
  {
    table: "sub_role_training_costs",
    exportName: "subRoleTrainingCosts",
    target: "owner",
    reason: "Training-cost learning is restaurant optimizer state.",
  },
  {
    table: "sub_role_training_moves",
    exportName: "subRoleTrainingMoves",
    target: "owner",
    reason: "Training moves are restaurant optimizer state.",
  },
  {
    table: "staffing_analysis_cache",
    exportName: "staffingAnalysisCache",
    target: "owner",
    reason: "Optimizer cache is derived from owner-local schedules and settings.",
  },
  {
    table: "cron_runs",
    exportName: "cronRuns",
    target: "split",
    reason: "Global cron orchestration belongs to master; per-owner job attempts and results belong to owner data.",
  },
] as const satisfies readonly Phase7TableBoundary[];

export const phase7MasterTables = phase7TableBoundaries.filter((entry) => entry.target === "master");
export const phase7OwnerTables = phase7TableBoundaries.filter((entry) => entry.target === "owner");
export const phase7SplitTables = phase7TableBoundaries.filter((entry) => entry.target === "split");

export function phase7BoundaryForTable(table: string) {
  return phase7TableBoundaries.find((entry) => entry.table === table);
}

