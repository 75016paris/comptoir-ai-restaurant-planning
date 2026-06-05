import { phase7OwnerTables, phase7SplitTables } from "./phase7-schema-boundaries";

export const phase7OwnerSchemaTableNames = phase7OwnerTables.map((entry) => entry.table);

export const phase7OwnerUserProjectionColumns = [
  "id",
  "display_name",
  "first_name",
  "last_name",
  "phone",
  "active",
] as const;

export const phase7OwnerEmploymentProfileTables = [
  "restaurant_memberships",
  "worker_restaurant_profiles",
] as const;

export const phase7SplitTablePlan = {
  users: {
    master: "login identity, password hash, global account status, global WhatsApp consent",
    owner: "display projection plus restaurant employment data through memberships and profiles",
  },
  legal_acceptances: {
    master: "owner/admin terms and DPA acceptance",
    owner: "future restaurant- or worker-specific notices, if added",
  },
  notifications: {
    master: "billing and global account notices",
    owner: "restaurant operational messages and delivery attempts",
  },
  chat_messages: {
    master: "pre-context routing or ambiguous-phone messages",
    owner: "restaurant-scoped tool transcripts after context selection",
  },
  cron_runs: {
    master: "fleet orchestration and per-owner failure summary",
    owner: "owner-local job attempt details and results",
  },
} as const satisfies Record<(typeof phase7SplitTables)[number]["table"], { master: string; owner: string }>;

export const phase7SplitTableExportBlockers = {
  users: "Covered by the current core snapshot as master login_identities plus owner-local users projection.",
  legal_acceptances: "Covered by the current core snapshot for owner/admin acceptance rows with owner_id.",
  notifications: "Scope columns now exist and 0122 backfills owner_id/restaurant_id where possible, but export remains deferred until the split exporter sends owner-only billing/global notices to master and restaurant_id delivery attempts to owner data.",
  chat_messages: "Scope columns now exist and 0122 backfills restaurant transcripts where possible, but export remains deferred until the split exporter uses the WhatsApp context kind to keep pre-context routing in master and restaurant transcripts in owner data.",
  cron_runs: "Scope columns now exist and new runs default to fleet scope, but export remains deferred until the split exporter maps fleet orchestration scope to master and owner scope attempts to owner data.",
} as const satisfies Record<(typeof phase7SplitTables)[number]["table"], string>;
