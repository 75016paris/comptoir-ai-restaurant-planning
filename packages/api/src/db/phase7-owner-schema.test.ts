import { describe, expect, test } from "bun:test";
import {
  phase7OwnerEmploymentProfileTables,
  phase7OwnerSchemaTableNames,
  phase7OwnerUserProjectionColumns,
  phase7SplitTableExportBlockers,
  phase7SplitTablePlan,
} from "./phase7-owner-schema";

describe("Phase 7 owner schema draft", () => {
  test("keeps restaurant operations in the owner schema", () => {
    expect(phase7OwnerSchemaTableNames).toContain("restaurants");
    expect(phase7OwnerSchemaTableNames).toContain("services");
    expect(phase7OwnerSchemaTableNames).toContain("documents");
    expect(phase7OwnerSchemaTableNames).toContain("time_clocks");
    expect(phase7OwnerSchemaTableNames).toContain("worker_weekly_hours");
  });

  test("does not put login-only tables in the owner schema", () => {
    expect(phase7OwnerSchemaTableNames).not.toContain("sessions");
    expect(phase7OwnerSchemaTableNames).not.toContain("password_reset_tokens");
    expect(phase7OwnerSchemaTableNames).not.toContain("pending_registrations");
  });

  test("defines a minimal owner-local user projection instead of copying password hashes", () => {
    expect([...phase7OwnerUserProjectionColumns]).toEqual([
      "id",
      "display_name",
      "first_name",
      "last_name",
      "phone",
      "active",
    ]);
    expect(phase7OwnerUserProjectionColumns).not.toContain("password_hash");
  });

  test("keeps employment data in membership/profile tables", () => {
    expect([...phase7OwnerEmploymentProfileTables]).toEqual([
      "restaurant_memberships",
      "worker_restaurant_profiles",
    ]);
  });

  test("requires an explicit split plan for mixed-responsibility tables", () => {
    expect(Object.keys(phase7SplitTablePlan).sort()).toEqual([
      "chat_messages",
      "cron_runs",
      "legal_acceptances",
      "notifications",
      "users",
    ]);
    expect(phase7SplitTablePlan.users.master).toContain("password hash");
    expect(phase7SplitTablePlan.users.owner).toContain("employment");
    expect(phase7SplitTableExportBlockers.notifications).toContain("restaurant_id");
    expect(phase7SplitTableExportBlockers.chat_messages).toContain("WhatsApp context");
    expect(phase7SplitTableExportBlockers.cron_runs).toContain("orchestration scope");
  });
});
