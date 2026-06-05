import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { DEFAULT_CONTRACT_HOURS } from "@comptoir/shared";

// SQLite doesn't have enums — we use text with CHECK constraints at app level

// ── Tables ──

export const owners = sqliteTable("owners", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status", { enum: ["active", "trialing", "past_due", "cancelled", "unpaid"] }).notNull().default("active"),
  subscriptionPeriodEnd: text("subscription_period_end"),
  trialEndsAt: text("trial_ends_at"),
  cancelAt: text("cancel_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const restaurants = sqliteTable("restaurants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").references(() => owners.id),
  name: text("name").notNull(),
  address: text("address"),
  siret: text("siret"), // 14 digits — restaurant-level URSSAF/DPAE id; Stripe keeps canonical metadata only for single-restaurant owners
  whatsappBotLocale: text("whatsapp_bot_locale", { enum: ["fr", "en", "es", "pt"] }).notNull().default("fr"), // bot prompts/tools currently FR-only; non-FR pending wa-i18n
  schoolZone: text("school_zone"), // A/B/C (vacances scolaires)
  holidayZone: text("holiday_zone"), // metropole/alsace-moselle (jours fériés)
  timezone: text("timezone").notNull().default("Europe/Paris"),
  status: text("status", { enum: ["active", "pending", "demo", "suspended"] }).notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status", { enum: ["active", "trialing", "past_due", "cancelled", "unpaid"] }).notNull().default("active"),
  subscriptionPeriodEnd: text("subscription_period_end"),
  trialEndsAt: text("trial_ends_at"),
  cancelAt: text("cancel_at"), // pending cancellation date — access continues until then
  cancellationReason: text("cancellation_reason"), // Stripe cancellation_details.reason
  cancellationFeedback: text("cancellation_feedback"), // Stripe cancellation_details.feedback
  cancellationComment: text("cancellation_comment"), // Stripe cancellation_details.comment
  cancellationRequestedAt: text("cancellation_requested_at"), // Stripe canceled_at — when cancellation was requested
  openDays: text("open_days").notNull().default("[2,3,4,5,6,7]"), // JSON array of day numbers (1=Mon..7=Sun). Default: Tue-Sun (Mon closed)
  medicalMode: integer("medical_mode", { mode: "boolean" }).notNull().default(false), // require doctor's note for sick leave
  tapInOutEnabled: integer("tap_in_out_enabled", { mode: "boolean" }).notNull().default(false), // enable tap in/out for workers
  tapInOutAdminConfirmation: integer("tap_in_out_admin_confirmation", { mode: "boolean" }).notNull().default(false), // when on, each tap-in/out queues a WhatsApp to the admin asking confirmation
  tapInOutMode: text("tap_in_out_mode", { enum: ["sync", "lateness_only"] }).notNull().default("lateness_only"), // sync = actual tap times feed hours recap; lateness_only = recap stays scheduled, taps surfaced only as lateness report
  tapInCountsAsHours: integer("tap_in_counts_as_hours", { mode: "boolean" }).notNull().default(false), // sync-mode only: when true, an early tap-in extends paid hours backwards; when false, only tap-out is authoritative (paid hours start at the scheduled service start)
  reminderFrequency: text("reminder_frequency", { enum: ["off", "daily", "weekly"] }).notNull().default("off"), // service recap frequency
  includeSilaeInMonthlyDigest: integer("include_silae_in_monthly_digest", { mode: "boolean" }).notNull().default(false),
  colorScheme: text("color_scheme", { enum: ["classic", "garden", "sunset", "ocean", "earth", "candy"] }).notNull().default("classic"),
  kitchenColor: text("kitchen_color").notNull().default("amber"),
  floorColor: text("floor_color").notNull().default("sky"),
  workerPreferencesEnabled: integer("worker_preferences_enabled", { mode: "boolean" }).notNull().default(true),
  autoStaffingWeeks: integer("auto_staffing_weeks").notNull().default(3), // 0=off, 1-4 = weeks in advance to auto-fill; 3W is the compliance-first default
  disabledComplianceRules: text("disabled_compliance_rules").notNull().default('["HCR-L3121-16"]'), // JSON array of disabled rule codes; L3121-16 (20-min break after 6h) is opt-in by default
  kitchenSubRoles: text("kitchen_sub_roles").notNull().default('["Chef","Cuisinier"]'),
  floorSubRoles: text("floor_sub_roles").notNull().default('["Chef de rang","Serveur"]'),
  overtimeMode: text("overtime_mode", { enum: ["strict", "controlled", "flexible"] }).notNull().default("flexible"),
  overtimeWeeklyCap: integer("overtime_weekly_cap").notNull().default(48), // 39-48, meaningful in 'controlled' mode
  overtimeDistribution: text("overtime_distribution", { enum: ["willing-first", "by-priority", "even"] }).notNull().default("willing-first"),
  hcrGrid: text("hcr_grid").notNull().default("{}"), // JSON Partial<HcrGrid> — per-restaurant overrides of 2026 baseline
  subroleHcrMap: text("subrole_hcr_map").notNull().default("{}"), // JSON Record<subrole, HcrLevel>
  defaultContractType: text("default_contract_type", { enum: ["CDI", "CDD", "saisonnier"] }).notNull().default("CDI"),
  defaultContractHours: integer("default_contract_hours").notNull().default(DEFAULT_CONTRACT_HOURS),
  silaeCodes: text("silae_codes").notNull().default("{}"), // JSON partial override of SILAE_DEFAULT_CODES
  // Named preset from packages/shared/src/weight-config.ts — picks a whole WeightConfig
  // (bucket values, consistency/preference/priority/flexibility, sub-role strictness).
  preferredStyle: text("preferred_style", { enum: ["equilibre", "equipe-stable", "economique", "resilience"] }).notNull().default("equipe-stable"),
  // Per-dimension semantic overrides on top of preferredStyle. JSON map of
  // TunableDimension → SemanticLevel (0..4). Missing keys inherit from preset.
  customWeights: text("custom_weights"),
  latitude: integer("latitude", { mode: "number" }),
  longitude: integer("longitude", { mode: "number" }),
  // Bumped by mutation routes to invalidate the multi-week baseline solver
  // cache. Folded into the cache key alongside content checksums.
  cacheVersion: integer("cache_version").notNull().default(0),
  // Deprecated: kept for DB compatibility. The optimizer no longer prices
  // covered staffing slots as revenue.
  revenuePerCoveredSlotCents: integer("revenue_per_covered_slot_cents"),
  onboardingCompletedAt: text("onboarding_completed_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(), // canonical full name = `${firstName} ${lastName}` for new rows
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "manager", "kitchen", "floor"] }).notNull(),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  priority: integer("priority").notNull().default(1), // 1 = top priority, higher = lower priority
  address: text("address"),                     // legacy single-line — kept synced as `${street}, ${postal} ${city}` for read sites
  addressStreet: text("address_street"),         // captured separately on /dossier so the worker fills three short inputs
  addressPostalCode: text("address_postal_code"),
  addressCity: text("address_city"),
  iban: text("iban"),
  startDate: text("start_date"),
  emergencyContact: text("emergency_contact"),
  emergencyPhone: text("emergency_phone"),
  dateOfBirth: text("date_of_birth"),       // YYYY-MM-DD — DPAE-mandatory
  birthPlace: text("birth_place"),          // ville (+ département) — DPAE-mandatory
  nationality: text("nationality"),         // ISO-ish, "FR" default applied in app
  nir: text("nir"),                         // numéro de sécurité sociale (13 + 2 key) — DPAE; null until URSSAF assigns
  notes: text("notes"),
  managerNotes: text("manager_notes"),
  subRole: text("sub_role"), // deprecated — use subRoles
  subRoles: text("sub_roles").notNull().default("[]"), // JSON array of sub-role strings. "Sous-chef" can fallback-fill "Chef" slots.
  overtimeWilling: integer("overtime_willing", { mode: "boolean" }).notNull().default(false),
  coupureWilling: integer("coupure_willing", { mode: "boolean" }).notNull().default(false), // worker accepts split shifts
  multiRestaurantWilling: integer("multi_restaurant_willing", { mode: "boolean" }).notNull().default(true), // worker opt-in gate; restaurant shares still require owner-side authorization
  matricule: text("matricule"), // Silae/payroll matricule — set by admin
  contractType: text("contract_type", { enum: ["CDI", "CDD", "saisonnier", "extra"] }),
  contractHours: integer("contract_hours"), // weekly hours in contract (e.g. 35, 39; 0 for extras without guaranteed hours)
  maxWeeklyHours: integer("max_weekly_hours"), // worker preference: max weekly hours they're willing to work (null = stick to contractHours)
  adminOtOverride: integer("admin_ot_override"), // admin override: surcharges restaurants.overtime_weekly_cap for this employee (null = no override)
  contractEndDate: text("contract_end_date"), // CDD/saisonnier end date (YYYY-MM-DD) — null for CDI
  hcrLevel: text("hcr_level"), // HCR niveau-échelon, e.g. "III-2" (null = unassigned; resolves from sub-role mapping)
  hourlyRate: integer("hourly_rate"), // admin override in cents — null = use grid[hcrLevel]
  rateEffectiveFrom: text("rate_effective_from"), // YYYY-MM-DD — date hourlyRate took effect (for historical cost replay)
  active: integer("active", { mode: "boolean" }).notNull().default(true), // soft delete — false = deactivated
  inactiveFrom: text("inactive_from"), // temp deactivation start date (YYYY-MM-DD)
  inactiveUntil: text("inactive_until"), // temp deactivation end date (YYYY-MM-DD)
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false), // forces /change-password redirect until the worker replaces a temporary password
  userNoticeVersion: text("user_notice_version"), // privacy + employee user notice version acknowledged by workers/managers
  userNoticeAcceptedAt: text("user_notice_accepted_at"),
  userNoticeIpAddress: text("user_notice_ip_address"),
  userNoticeUserAgent: text("user_notice_user_agent"),
  whatsappOptIn: integer("whatsapp_opt_in", { mode: "boolean" }).notNull().default(false), // optional worker/manager consent for WhatsApp assistant + notifications
  whatsappOptInAt: text("whatsapp_opt_in_at"),
  whatsappOptOutAt: text("whatsapp_opt_out_at"),
  lastDossierReminderAt: text("last_dossier_reminder_at"), // throttle for /cron/dossier-reminders (3-day cadence)
  permissions: text("permissions"), // JSON: Partial<Record<Permission, boolean>> for per-user overrides; null = use role defaults
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const ownerMemberships = sqliteTable("owner_memberships", {
  ownerId: text("owner_id").notNull().references(() => owners.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["owner_admin", "owner_manager", "member"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.ownerId, t.userId] }),
}));

export const restaurantMemberships = sqliteTable("restaurant_memberships", {
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["admin", "manager", "kitchen", "floor"] }).notNull(),
  permissions: text("permissions"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.restaurantId, t.userId] }),
}));

export const workerRestaurantProfiles = sqliteTable("worker_restaurant_profiles", {
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  userId: text("user_id").notNull().references(() => users.id),
  priority: integer("priority").notNull().default(1),
  subRoles: text("sub_roles").notNull().default("[]"),
  contractType: text("contract_type", { enum: ["CDI", "CDD", "saisonnier", "extra"] }),
  contractHours: integer("contract_hours"),
  contractEndDate: text("contract_end_date"),
  maxWeeklyHours: integer("max_weekly_hours"),
  adminOtOverride: integer("admin_ot_override"),
  hcrLevel: text("hcr_level"),
  hourlyRate: integer("hourly_rate"),
  matricule: text("matricule"),
  managerNotes: text("manager_notes"),
  multiRestaurantWilling: integer("multi_restaurant_willing", { mode: "boolean" }).notNull().default(true), // worker opt-in gate; restaurant shares still require owner-side authorization
}, (t) => ({
  pk: primaryKey({ columns: [t.restaurantId, t.userId] }),
}));

export const workerShareAuthorizations = sqliteTable("worker_share_authorizations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().references(() => owners.id),
  sourceRestaurantId: text("source_restaurant_id").notNull().references(() => restaurants.id),
  targetRestaurantId: text("target_restaurant_id").notNull().references(() => restaurants.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["kitchen", "floor"] }).notNull(),
  status: text("status", { enum: ["pending", "accepted", "revoked"] }).notNull().default("pending"),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id),
  workerConsentedAt: text("worker_consented_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  holidayRequestId: text("holiday_request_id").references(() => holidayRequests.id), // links doc to a specific holiday request
  replacementRequestId: text("replacement_request_id").references((): any => replacementRequests.id), // links doc to a replacement request (ITT/arrêt maladie)
  name: text("name").notNull(),
  type: text("type", { enum: ["id", "contract", "certificate", "medical", "other"] }).notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  data: text("data").notNull(), // legacy base64 — empty string for storageProvider='ovh' rows since Phase E (migration 0098); only carries bytes for unbackfilled pre-Phase-C rows
  storageProvider: text("storage_provider", { enum: ["ovh", "sqlite"] }), // NULL = legacy row served from `data`; 'ovh' = served via presigned URL on storageKey
  storageKey: text("storage_key"), // bucket key when storageProvider='ovh'
  storageStatus: text("storage_status", { enum: ["pending", "ready", "deleted"] }).notNull().default("ready"),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id),
  requirementKey: text("requirement_key"), // onboarding checklist slug, e.g. "id_card", "medical_cert". Null for legacy / ad-hoc docs.
  issuedAt: text("issued_at"),              // YYYY-MM-DD — relevant for recency rules (proof of residence < 3 months)
  expiresAt: text("expires_at"),            // YYYY-MM-DD — medical cert, HACCP, work permit expire. Used for renewal reminders.
  signedAt: text("signed_at"),              // YYYY-MM-DD — when a contract was signed. Null = draft / unsigned. Only relevant for type='contract'.
  reviewedAt: text("reviewed_at"),          // ISO timestamp set when admin/manager confirms a worker-uploaded doc. NULL = pending review (excluded from checklist).
  reviewedBy: text("reviewed_by").references((): any => users.id), // admin who confirmed
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const timeClocks = sqliteTable("time_clocks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  serviceId: text("service_id").references(() => services.id),
  tapIn: text("tap_in").notNull(), // ISO datetime
  tapOut: text("tap_out"), // ISO datetime, null if still clocked in
  date: text("date").notNull(), // YYYY-MM-DD
  adminConfirmedAt: text("admin_confirmed_at"), // ISO timestamp when manager/admin confirmed the tap event
  adminConfirmedBy: text("admin_confirmed_by").references((): any => users.id),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const dailyRevenue = sqliteTable("daily_revenue", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  date: text("date").notNull(), // YYYY-MM-DD
  amount: integer("amount").notNull(), // cents to avoid float issues
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  activeRestaurantId: text("active_restaurant_id").references(() => restaurants.id),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const legalAcceptances = sqliteTable("legal_acceptances", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").references(() => owners.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  userId: text("user_id").notNull().references(() => users.id),
  acceptanceType: text("acceptance_type", { enum: ["owner_terms"] }).notNull(),
  termsVersion: text("terms_version").notNull(),
  dpaVersion: text("dpa_version").notNull(),
  privacyVersion: text("privacy_version").notNull(),
  subprocessorsVersion: text("subprocessors_version").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  acceptedAt: text("accepted_at").notNull().default(sql`(datetime('now'))`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const services = sqliteTable("services", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workerId: text("worker_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  date: text("date").notNull(), // YYYY-MM-DD
  startTime: text("start_time").notNull(), // HH:MM
  endTime: text("end_time").notNull(), // HH:MM
  role: text("role", { enum: ["kitchen", "floor"] }).notNull(),
  status: text("status", { enum: ["scheduled", "replacement_pending", "completed", "cancelled"] }).notNull().default("scheduled"),
  source: text("source", { enum: ["manual", "auto"] }).notNull().default("manual"), // who created: manual (UI/bot) or auto (autostaffing engine)
  filledAs: text("filled_as"), // when set, indicates the worker fills this slot via a non-exact sub-role substitution (e.g. Sandra fills Cuisinier as Sous-chef). Null = exact match or restaurant doesn't use sub-role breakdowns.
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Replacement requests — worker says "can't come", admin brokers a replacement.
export const replacementRequests = sqliteTable("replacement_requests", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  requesterId: text("requester_id").notNull().references(() => users.id),
  requesterServiceId: text("requester_service_id").notNull().references(() => services.id),
  targetId: text("target_id").references(() => users.id), // null until admin picks; stays null for broadcast
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  status: text("status", { enum: [
    "awaiting_admin_decision",
    "awaiting_worker_reply",
    "accepted",
    "approved_without_replacement",
    "rejected",
    "expired",
    "cancelled",
  ] }).notNull().default("awaiting_admin_decision"),
  message: text("message"),
  respondedAt: text("responded_at"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  candidateIds: text("candidate_ids", { mode: "json" }).$type<string[]>(),
  candidateScores: text("candidate_scores", { mode: "json" }).$type<Record<string, number>>(),
  adminNotifiedAt: text("admin_notified_at"),
  workerNotifiedAt: text("worker_notified_at"),
  escalationCount: integer("escalation_count").notNull().default(0),
  rejectedCandidateIds: text("rejected_candidate_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  medical: integer("medical", { mode: "boolean" }).notNull().default(false), // arrêt maladie — ITT document expected
  ittReminderSentAt: text("itt_reminder_sent_at"), // last time we pinged the worker for the ITT
});

// Open shifts — admin posts a vacant slot, broadcast to eligible workers, first-come claim wins.
// Distinct from replacement_requests (which models "I'm dropping a confirmed shift" with a requester).
export const openShifts = sqliteTable("open_shifts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  createdBy: text("created_by").notNull().references(() => users.id),
  date: text("date").notNull(),               // YYYY-MM-DD
  startTime: text("start_time").notNull(),    // HH:MM
  endTime: text("end_time").notNull(),        // HH:MM
  role: text("role", { enum: ["kitchen", "floor"] }).notNull(),
  requiredSubRoles: text("required_sub_roles", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  message: text("message"),
  candidateIds: text("candidate_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  rejectedCandidateIds: text("rejected_candidate_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  solicitedCandidateIds: text("solicited_candidate_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  lastSolicitedAt: text("last_solicited_at"),
  status: text("status", { enum: ["open", "claimed", "cancelled", "expired"] }).notNull().default("open"),
  claimedBy: text("claimed_by").references(() => users.id),
  claimedAt: text("claimed_at"),
  serviceId: text("service_id").references(() => services.id), // created on claim
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const holidayRequests = sqliteTable("holiday_requests", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workerId: text("worker_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  startDate: text("start_date").notNull(), // YYYY-MM-DD
  endDate: text("end_date").notNull(), // YYYY-MM-DD
  reason: text("reason"),
  medical: integer("medical", { mode: "boolean" }).notNull().default(false), // sick leave — doctor's note expected
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  // worker = employee submitted the request; admin_proposal = admin proposed and
  // the worker must accept/reject (reverse flow).
  source: text("source", { enum: ["worker", "admin_proposal"] }).notNull().default("worker"),
  reviewedBy: text("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  recipientId: text("recipient_id").notNull().references(() => users.id),
  ownerId: text("owner_id").references(() => owners.id),
  restaurantId: text("restaurant_id").references(() => restaurants.id),
  type: text("type", { enum: [
    "service_reminder", "replacement_proposal", "replacement_accepted", "replacement_rejected",
    "replacement_expired", "schedule_change", "holiday_approved", "holiday_rejected",
    "holiday_request", "holiday_proposal", "replacement_request",
    "trial_ending", "payment_failed", "subscription_cancelled",
    "time_clock_confirm",
    "open_shift_broadcast", "open_shift_claimed", "open_shift_no_response",
    "dossier_reminder",
  ]}).notNull(),
  channel: text("channel", { enum: ["whatsapp", "sms"] }).notNull().default("whatsapp"),
  message: text("message").notNull(),
  status: text("status", { enum: ["queued", "sent", "failed"] }).notNull().default("queued"),
  scheduledFor: text("scheduled_for").notNull(),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// In-app admin/manager popup queue. Distinct from `notifications` (which is
// outbound WhatsApp/SMS to workers) — these surface in the admin shell on
// next app open. Created from server-side events the admin should react to.
export const adminAlerts = sqliteTable("admin_alerts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  recipientId: text("recipient_id").notNull().references(() => users.id),
  type: text("type").notNull(),       // free-form so we don't migrate every time we add an alert
  title: text("title").notNull(),
  body: text("body").notNull(),
  actionUrl: text("action_url"),
  workerId: text("worker_id").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  seenAt: text("seen_at"),
});

// Restaurant closure periods — full close or reduced schedule
export const restaurantClosures = sqliteTable("restaurant_closures", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  startDate: text("start_date").notNull(), // YYYY-MM-DD
  endDate: text("end_date").notNull(), // YYYY-MM-DD
  reason: text("reason"),
  // Optional reduced-schedule JSON: { days: {dayNum: "both"|"midi"|"soir"}, kitchen: N, service: N, times: {...} }
  schedule: text("schedule"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Default service timings per role + zone (restaurant-level config)
export const serviceTemplates = sqliteTable("service_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  profileId: text("profile_id").references(() => staffingProfiles.id), // null = global default
  role: text("role", { enum: ["kitchen", "floor"] }).notNull(),
  zone: text("zone").notNull(), // free-text service group label (was enum midi/soir)
  startTime: text("start_time").notNull(), // HH:MM
  endTime: text("end_time").notNull(), // HH:MM
  sortOrder: integer("sort_order").notNull().default(0),
});

// Per-day-of-week time overrides for service templates
export const serviceTemplateOverrides = sqliteTable("service_template_overrides", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  templateId: text("template_id").notNull().references(() => serviceTemplates.id),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon, 2=Tue, ..., 7=Sun
  startTime: text("start_time").notNull(), // HH:MM
  endTime: text("end_time").notNull(), // HH:MM
});

// Per-worker availability: which days + zones they can work
export const workerAvailability = sqliteTable("worker_availability", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workerId: text("worker_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon, 2=Tue, ..., 7=Sun
  midi: integer("midi", { mode: "boolean" }).notNull().default(false),
  soir: integer("soir", { mode: "boolean" }).notNull().default(false),
  midiStart: text("midi_start"), // HH:MM — null = use restaurant template
  midiEnd: text("midi_end"),
  soirStart: text("soir_start"),
  soirEnd: text("soir_end"),
  continuous: integer("continuous", { mode: "boolean" }).notNull().default(false),
  zones: text("zones").notNull().default("{}"), // JSON: {"Matin": true, "Continu": false, ...}
});

// Staffing profiles — named sets of staffing targets
export const staffingProfiles = sqliteTable("staffing_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  name: text("name").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  dayPriorities: text("day_priorities").notNull().default("{}"), // JSON: {"1":2,"5":1} — lower number = higher importance
  preferredAssignments: text("preferred_assignments").notNull().default("[]"), // JSON Array<{workerId, dayOfWeek, zone, role}> — per-slot titulaire pinning for équipe-stable seeding
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Staffing schedule — assign profiles to specific weeks
export const staffingSchedule = sqliteTable("staffing_schedule", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  profileId: text("profile_id").notNull().references(() => staffingProfiles.id),
  year: integer("year").notNull(),
  week: integer("week").notNull(), // ISO week number
});

// Staffing targets — how many workers per role per zone per day-of-week
export const staffingTargets = sqliteTable("staffing_targets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  profileId: text("profile_id").references(() => staffingProfiles.id),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon, 7=Sun
  role: text("role", { enum: ["kitchen", "floor"] }).notNull(),
  zone: text("zone").notNull(), // free-text service group label (was enum midi/soir)
  count: integer("count").notNull().default(0),
  roleBreakdown: text("role_breakdown").notNull().default("{}"), // JSON: {"Chef":1,"Cuisinier":2}
});

// Calendar events: public holidays + school vacations
export const calendarEvents = sqliteTable("calendar_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  type: text("type", { enum: ["public_holiday", "school_vacation"] }).notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  endDate: text("end_date"), // YYYY-MM-DD (vacations only)
  name: text("name").notNull(),
  zone: text("zone"), // metropole/alsace-moselle or A/B/C
  year: integer("year").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Pending registrations — before Stripe payment confirms
export const pendingRegistrations = sqliteTable("pending_registrations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantName: text("restaurant_name").notNull(),
  adminName: text("admin_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  stripeSessionId: text("stripe_session_id"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

// Password reset tokens
export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  used: integer("used", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

// Magic-link tokens for the no-login onboarding/profile-completion page.
// Multi-visit by design: stays valid until expires_at so the worker can
// come back and finish later (e.g. upload a doc photo, fix a typo).
export const onboardingTokens = sqliteTable("onboarding_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").references(() => restaurants.id),
  token: text("token").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

// WhatsApp bot conversation history (shared DB)
export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id),
  ownerId: text("owner_id").references(() => owners.id),
  restaurantId: text("restaurant_id").references(() => restaurants.id),
  contextKind: text("context_kind", { enum: ["pre_context", "restaurant_context"] }),
  role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull(),
  toolCalls: text("tool_calls"), // JSON — serialized tool calls/results
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Short-lived WhatsApp active restaurant context for ambiguous phone numbers.
export const whatsappContextSessions = sqliteTable("whatsapp_context_sessions", {
  phone: text("phone").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  selectedAt: text("selected_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

// Worker restrictions: time-slot based unavailability (replaces zone-based availability)
export const workerRestrictions = sqliteTable("worker_restrictions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workerId: text("worker_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon, 7=Sun
  startTime: text("start_time"), // HH:MM or null for full day
  endTime: text("end_time"), // HH:MM or null for full day
  reason: text("reason"),
  effectiveFrom: text("effective_from"), // YYYY-MM-DD, null = always-on (permanent)
  effectiveUntil: text("effective_until"), // YYYY-MM-DD, null = no end
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Worker-submitted availability change requests — require admin approval before taking effect.
export const restrictionRequests = sqliteTable("restriction_requests", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workerId: text("worker_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  kind: text("kind", { enum: ["permanent", "temporary"] }).notNull(),
  effectiveFrom: text("effective_from"), // YYYY-MM-DD, required if temporary
  effectiveUntil: text("effective_until"), // YYYY-MM-DD, required if temporary
  restrictions: text("restrictions").notNull().default("[]"), // JSON array of {dayOfWeek, startTime, endTime, reason}
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] }).notNull().default("pending"),
  note: text("note"), // worker's justification
  adminNote: text("admin_note"), // admin's review note
  reviewedBy: text("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Worker-managed preferred schedule — when they'd like to work (advisory, not binding)
export const workerPreferredSchedule = sqliteTable("worker_preferred_schedule", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workerId: text("worker_id").notNull().references(() => users.id),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon, 7=Sun
  midi: integer("midi", { mode: "boolean" }).notNull().default(false),
  soir: integer("soir", { mode: "boolean" }).notNull().default(false),
  zones: text("zones").notNull().default("{}"), // JSON: {"Matin": true, ...}
});

// Audit log — tracks all mutating actions across the system
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  tableName: text("table_name").notNull(), // e.g. "services", "holiday_requests", "replacement_requests"
  rowId: text("row_id").notNull(), // PK of the affected row
  action: text("action", { enum: ["insert", "update", "delete"] }).notNull(),
  actorId: text("actor_id").references(() => users.id), // null for system/cron actions
  actorName: text("actor_name"), // denormalized for quick display
  source: text("source").notNull(), // dashboard | bot:admin | bot:worker | auto-scheduler | cron
  changes: text("changes"), // JSON: { field: { old, new } } for updates, full row for insert/delete
  summary: text("summary"), // human-readable one-liner, e.g. "Créé service 10:00-14:00 pour Alice (lundi)"
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Weather data — daily + hourly weather per restaurant per date
export const weatherData = sqliteTable("weather_data", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  date: text("date").notNull(),
  weatherCode: integer("weather_code"),
  tempMax: integer("temp_max", { mode: "number" }),
  tempMin: integer("temp_min", { mode: "number" }),
  sunrise: text("sunrise"),
  sunset: text("sunset"),
  normalTempMax: integer("normal_temp_max", { mode: "number" }),
  normalTempMin: integer("normal_temp_min", { mode: "number" }),
  hourlyWeatherCodes: text("hourly_weather_codes"), // JSON array
  hourlyTemperatures: text("hourly_temperatures"), // JSON array
  isForecast: integer("is_forecast", { mode: "boolean" }).notNull().default(true),
  fetchedAt: text("fetched_at").notNull().default(sql`(datetime('now'))`),
});

// Contract templates — HCR boilerplates (CDI / CDD / saisonnier / extra)
// editable per restaurant. Mustache-style {{token}} substitution on bodyHtml.
export const contractTemplates = sqliteTable("contract_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  kind: text("kind", { enum: ["CDI", "CDD", "saisonnier", "extra"] }).notNull(),
  name: text("name").notNull(),
  bodyHtml: text("body_html").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Published weeks — marks a week as visible to employees
export const publishedWeeks = sqliteTable("published_weeks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  weekDate: text("week_date").notNull(), // Monday of the week (YYYY-MM-DD)
  publishedAt: text("published_at").notNull().default(sql`(datetime('now'))`),
});

// Additional email recipients (comptable, co-admin, etc.) with per-type opt-ins.
// The admin's login email is not stored here — they receive everything they've
// subscribed to via their users.email. This table is the extra dispatch list.
export const emailRecipients = sqliteTable("email_recipients", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  label: text("label").notNull(), // "Comptable", "Jean Dupont"
  email: text("email").notNull(),
  sendMonthlyDigest: integer("send_monthly_digest", { mode: "boolean" }).notNull().default(false),
  sendLeaveAlerts: integer("send_leave_alerts", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Materialized per-worker per-week hours used by the C9 freshness gate.
// Populated by `services` triggers or a nightly cron (follow-up task).
// Currently gated behind USE_WEEKLY_HOURS_VIEW — the solver still reads from
// `services` by default until the view has been validated in production.
export const workerWeeklyHours = sqliteTable("worker_weekly_hours", {
  workerId: text("worker_id").notNull(),
  weekStart: text("week_start").notNull(), // ISO Monday, YYYY-MM-DD
  hoursActual: real("hours_actual").notNull(),
  recordedAt: integer("recorded_at").notNull(), // unix ms
  source: text("source").notNull().default("services"), // "services" | "manual"
}, (t) => ({
  pk: primaryKey({ columns: [t.workerId, t.weekStart] }),
}));

// Per-restaurant learned training costs. Replaces the KITCHEN_HIERARCHY /
// SALLE_HIERARCHY fallbacks in optimize-engine.ts once a given
// (fromRole, toRole) pair has >= 5 observations. adminOverride=true freezes
// the row against the nightly learning loop.
export const subRoleTrainingCosts = sqliteTable("sub_role_training_costs", {
  restaurantId: text("restaurant_id").notNull(),
  fromRole: text("from_role").notNull(),
  toRole: text("to_role").notNull(),
  costPoints: real("cost_points").notNull(),
  successes: integer("successes").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  lastUpdated: integer("last_updated").notNull(),
  adminOverride: integer("admin_override", { mode: "boolean" }).notNull().default(false),
}, (t) => ({
  pk: primaryKey({ columns: [t.restaurantId, t.fromRole, t.toRole] }),
}));

// Applied cross_train / intra_train moves awaiting outcome observation.
// Rows with observed_at=NULL are picked up by the nightly training-outcomes
// cron, classified success/failure, and fold their outcome into the
// sub_role_training_costs row via a Bayesian update.
export const subRoleTrainingMoves = sqliteTable("sub_role_training_moves", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull(),
  workerId: text("worker_id").notNull(),
  moveType: text("move_type", { enum: ["cross_train", "intra_train"] }).notNull(),
  fromRole: text("from_role").notNull(),
  toRole: text("to_role").notNull(),
  appliedAt: integer("applied_at").notNull(),
  observedAt: integer("observed_at"),
  outcome: text("outcome", { enum: ["success", "failure"] }),
});

// Persisted long-horizon staffing-analysis results. The interactive /staff
// panel solves a shorter horizon synchronously; this cache stores the heavier
// 12-week solve when a background refresh completes.
export const staffingAnalysisCache = sqliteTable("staffing_analysis_cache", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  restaurantId: text("restaurant_id").notNull().references(() => restaurants.id),
  profileId: text("profile_id"),
  horizonWeeks: integer("horizon_weeks").notNull(),
  baseMonday: text("base_monday").notNull(),
  cacheKey: text("cache_key").notNull().unique(),
  status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  result: text("result"),
  error: text("error"),
});

// One row per cron handler attempt. Phase A of the background-jobs strategy
// (id:67f8): the retry wrapper writes a 'running' row at start and updates to
// 'ok'/'error' on completion. Aide tab reads the most recent row per job_name.
export const cronRuns = sqliteTable("cron_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobName: text("job_name").notNull(),
  ownerId: text("owner_id").references(() => owners.id),
  scope: text("scope", { enum: ["fleet", "owner"] }),
  attempt: integer("attempt").notNull().default(1),
  status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  error: text("error"),
  result: text("result"),
});
