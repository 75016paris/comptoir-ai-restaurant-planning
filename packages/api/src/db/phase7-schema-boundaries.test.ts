import { describe, expect, test } from "bun:test";
import {
  phase7BoundaryForTable,
  phase7MasterTables,
  phase7OwnerTables,
  phase7SplitTables,
  phase7TableBoundaries,
} from "./phase7-schema-boundaries";

const currentSchemaTables = [
  "owners",
  "restaurants",
  "users",
  "owner_memberships",
  "restaurant_memberships",
  "worker_restaurant_profiles",
  "worker_share_authorizations",
  "documents",
  "time_clocks",
  "daily_revenue",
  "sessions",
  "legal_acceptances",
  "services",
  "replacement_requests",
  "open_shifts",
  "holiday_requests",
  "notifications",
  "admin_alerts",
  "restaurant_closures",
  "service_templates",
  "service_template_overrides",
  "worker_availability",
  "staffing_profiles",
  "staffing_schedule",
  "staffing_targets",
  "calendar_events",
  "pending_registrations",
  "password_reset_tokens",
  "onboarding_tokens",
  "chat_messages",
  "whatsapp_context_sessions",
  "worker_restrictions",
  "restriction_requests",
  "worker_preferred_schedule",
  "audit_logs",
  "weather_data",
  "contract_templates",
  "published_weeks",
  "email_recipients",
  "worker_weekly_hours",
  "sub_role_training_costs",
  "sub_role_training_moves",
  "staffing_analysis_cache",
  "cron_runs",
] as const;

describe("Phase 7 schema boundaries", () => {
  test("classifies every current logical table exactly once", () => {
    const covered = phase7TableBoundaries.map((entry) => entry.table);

    expect(covered).toHaveLength(currentSchemaTables.length);
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...currentSchemaTables].sort());
  });

  test("keeps login and routing tables in the master schema", () => {
    expect(phase7MasterTables.map((entry) => entry.table).sort()).toEqual([
      "owner_memberships",
      "owners",
      "password_reset_tokens",
      "pending_registrations",
      "sessions",
      "whatsapp_context_sessions",
    ]);
  });

  test("marks mixed-responsibility tables as split instead of pretending they move as-is", () => {
    expect(phase7SplitTables.map((entry) => entry.table).sort()).toEqual([
      "chat_messages",
      "cron_runs",
      "legal_acceptances",
      "notifications",
      "users",
    ]);
  });

  test("keeps restaurant operations in owner schemas", () => {
    expect(phase7OwnerTables.length).toBe(33);
    expect(phase7BoundaryForTable("services")?.target).toBe("owner");
    expect(phase7BoundaryForTable("documents")?.target).toBe("owner");
    expect(phase7BoundaryForTable("payroll_exports")?.target).toBeUndefined();
  });
});

