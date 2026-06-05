import { primaryKey, sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const phase7LoginIdentities = sqliteTable("login_identities", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  displayName: text("display_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  userNoticeVersion: text("user_notice_version"),
  userNoticeAcceptedAt: text("user_notice_accepted_at"),
  userNoticeIpAddress: text("user_notice_ip_address"),
  userNoticeUserAgent: text("user_notice_user_agent"),
  whatsappOptIn: integer("whatsapp_opt_in", { mode: "boolean" }).notNull().default(false),
  whatsappOptInAt: text("whatsapp_opt_in_at"),
  whatsappOptOutAt: text("whatsapp_opt_out_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const phase7Owners = sqliteTable("owners", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  databasePath: text("database_path").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status", {
    enum: ["active", "trialing", "past_due", "cancelled", "unpaid"],
  }).notNull().default("active"),
  subscriptionPeriodEnd: text("subscription_period_end"),
  trialEndsAt: text("trial_ends_at"),
  cancelAt: text("cancel_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const phase7OwnerMemberships = sqliteTable("owner_memberships", {
  ownerId: text("owner_id").notNull().references(() => phase7Owners.id),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
  role: text("role", { enum: ["owner_admin", "owner_manager", "member"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.ownerId, t.userId] }),
}));

export const phase7Sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
  activeOwnerId: text("active_owner_id").references(() => phase7Owners.id),
  activeRestaurantId: text("active_restaurant_id"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const phase7PasswordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
  token: text("token").notNull().unique(),
  used: integer("used", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

export const phase7PendingRegistrations = sqliteTable("pending_registrations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerName: text("owner_name").notNull(),
  firstRestaurantName: text("first_restaurant_name").notNull(),
  adminName: text("admin_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  passwordHash: text("password_hash").notNull(),
  stripeSessionId: text("stripe_session_id"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

export const phase7OwnerLegalAcceptances = sqliteTable("owner_legal_acceptances", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerId: text("owner_id").notNull().references(() => phase7Owners.id),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
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

export const phase7PhoneRoutes = sqliteTable("phone_routes", {
  phone: text("phone").notNull(),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
  ownerId: text("owner_id").notNull().references(() => phase7Owners.id),
  restaurantId: text("restaurant_id"),
  role: text("role", { enum: ["admin", "manager", "kitchen", "floor"] }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.phone, t.userId, t.ownerId, t.restaurantId] }),
}));

export const phase7WhatsappContextSessions = sqliteTable("whatsapp_context_sessions", {
  phone: text("phone").primaryKey(),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
  ownerId: text("owner_id").notNull().references(() => phase7Owners.id),
  restaurantId: text("restaurant_id").notNull(),
  selectedAt: text("selected_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

export const phase7MasterNotifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  recipientId: text("recipient_id").notNull().references(() => phase7LoginIdentities.id),
  ownerId: text("owner_id").references(() => phase7Owners.id),
  restaurantId: text("restaurant_id"),
  type: text("type").notNull(),
  channel: text("channel").notNull().default("whatsapp"),
  message: text("message").notNull(),
  status: text("status").notNull().default("queued"),
  scheduledFor: text("scheduled_for").notNull(),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const phase7MasterChatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => phase7LoginIdentities.id),
  ownerId: text("owner_id").references(() => phase7Owners.id),
  contextKind: text("context_kind").notNull().default("pre_context"),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: text("tool_calls"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const phase7MasterCronRuns = sqliteTable("cron_runs", {
  id: integer("id").primaryKey(),
  jobName: text("job_name").notNull(),
  ownerId: text("owner_id").references(() => phase7Owners.id),
  scope: text("scope").notNull().default("fleet"),
  attempt: integer("attempt").notNull().default(1),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  error: text("error"),
  result: text("result"),
});

export const phase7MasterSchemaTableNames = [
  "login_identities",
  "owners",
  "owner_memberships",
  "sessions",
  "password_reset_tokens",
  "pending_registrations",
  "owner_legal_acceptances",
  "phone_routes",
  "whatsapp_context_sessions",
  "notifications",
  "chat_messages",
  "cron_runs",
] as const;
