import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-perm-test-")), "test.db");

const { extractStripeCancellationDetails, validateRegistrationBillingConfig } = await import("./auth.js");
const { canRunDemoOptimization } = await import("./autostaffing.js");
const { validateDemoAudioUpload, validateDemoMessage } = await import("./demo-chat.js");
const { canFindReplacementCandidatesForService } = await import("./replacements.js");
const { canViewDraftSchedule, canViewHoursForWorker, canViewMonthlyRecap, filterRowsToPublishedWeeks, workerBelongsToRestaurant } = await import("./schedule.js");
const { hashToken, isHashedToken, redactSensitiveString } = await import("../utils/token-security.js");
const {
  canAccessDocumentType,
  canAccessUserScopedResource,
  getForbiddenSensitiveTeamUpdateFields,
  getForbiddenTeamUpdateFields,
  parseManagerPermissionOverrides,
  sanitizeUserForViewer,
  workerUserSelect,
} = await import("./users.js");

describe("manager permission helpers", () => {
  test("HOURS_VIEW gates team hours even when PLANNING_EDIT remains enabled", () => {
    const manager = {
      id: "manager-1",
      role: "manager" as const,
      permissions: JSON.stringify({ HOURS_VIEW: false, PLANNING_EDIT: true }),
    };

    expect(canViewHoursForWorker(manager, "worker-1")).toBe(false);
    expect(canViewMonthlyRecap(manager)).toBe(false);
  });

  test("HOURS_VIEW allows team hours", () => {
    const manager = {
      id: "manager-1",
      role: "manager" as const,
      permissions: JSON.stringify({ HOURS_VIEW: true }),
    };

    expect(canViewHoursForWorker(manager, "worker-1")).toBe(true);
    expect(canViewMonthlyRecap(manager)).toBe(true);
  });

  test("draft schedule visibility follows PLANNING_EDIT", () => {
    const manager = { role: "manager" as const, permissions: JSON.stringify({ PLANNING_EDIT: true }) };
    const worker = { role: "floor" as const, permissions: null };

    expect(canViewDraftSchedule(manager)).toBe(true);
    expect(canViewDraftSchedule(worker)).toBe(false);
  });

  test("published-week filter removes draft-week rows", () => {
    const rows = [
      { id: "draft", date: "2026-05-05" },
      { id: "published", date: "2026-05-12" },
    ];

    expect(filterRowsToPublishedWeeks(rows, new Set(["2026-05-11"]))).toEqual([{ id: "published", date: "2026-05-12" }]);
  });

  test("TEAM_EDIT managers can submit allowed non-sensitive employee fields", () => {
    expect(getForbiddenTeamUpdateFields({ phone: "+33600000000", subRole: "chef" }, false)).toEqual([]);
  });

  test("sensitive employee fields are gated by narrower permissions", () => {
    const manager = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ HR_DATA_EDIT: false, PAYROLL_VIEW: false, MANAGER_NOTES_EDIT: false }) };
    expect(getForbiddenSensitiveTeamUpdateFields({ phone: "+33600000000", iban: "FR76", hourlyRate: 1400, managerNotes: "OK" }, manager))
      .toEqual(["iban", "hourlyRate", "managerNotes"]);
  });

  test("sensitive employee fields remain allowed for current manager defaults", () => {
    const manager = { id: "manager-1", role: "manager" as const, permissions: null };
    expect(getForbiddenSensitiveTeamUpdateFields({ iban: "FR76", hourlyRate: 1400, managerNotes: "OK" }, manager)).toEqual([]);
  });

  test("manager responses are stripped when narrower view permissions are revoked", () => {
    const manager = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ HR_DATA_VIEW: false, PAYROLL_VIEW: false, MANAGER_NOTES_EDIT: false }) };
    const row = sanitizeUserForViewer({ id: "worker-1", name: "Worker", iban: "FR76", nir: "1234567890123", hourlyRate: 1400, managerNotes: "secret", phone: "+336" } as Record<string, unknown>, manager);
    expect(row).toEqual({ id: "worker-1", name: "Worker", phone: "+336" });
  });

  test("worker coworker select is limited to scheduling identity", () => {
    expect(Object.keys(workerUserSelect).sort()).toEqual(["active", "id", "name", "role", "subRole", "subRoles"]);
  });

  test("replacement candidate scoring is limited to managers or the service owner", () => {
    const worker = { id: "worker-1", role: "floor" as const, permissions: null };
    const otherWorker = { id: "worker-2", role: "kitchen" as const, permissions: null };
    const planner = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ PLANNING_EDIT: true, REPLACEMENT_APPROVE: false }) };
    const replacementManager = { id: "manager-2", role: "manager" as const, permissions: JSON.stringify({ PLANNING_EDIT: false, REPLACEMENT_APPROVE: true }) };
    const readonlyManager = { id: "manager-3", role: "manager" as const, permissions: JSON.stringify({ PLANNING_EDIT: false, REPLACEMENT_APPROVE: false }) };

    expect(canFindReplacementCandidatesForService(worker, "worker-1")).toBe(true);
    expect(canFindReplacementCandidatesForService(otherWorker, "worker-1")).toBe(false);
    expect(canFindReplacementCandidatesForService(planner, "worker-1")).toBe(true);
    expect(canFindReplacementCandidatesForService(replacementManager, "worker-1")).toBe(true);
    expect(canFindReplacementCandidatesForService(readonlyManager, "worker-1")).toBe(false);
  });

  test("document access follows specific sensitive document permissions", () => {
    const defaultManager = { id: "manager-1", role: "manager" as const, permissions: null };
    const revokedMedicalManager = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ MEDICAL_DOC_VIEW: false }) };
    const revokedHrManager = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ HR_DATA_VIEW: false }) };
    const revokedPayrollManager = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ PAYROLL_VIEW: false }) };
    expect(canAccessDocumentType(defaultManager, "worker-1", "contract")).toBe(true);
    expect(canAccessDocumentType(defaultManager, "worker-1", "medical")).toBe(true);
    expect(canAccessDocumentType(revokedMedicalManager, "worker-1", "medical")).toBe(false);
    expect(canAccessDocumentType(revokedHrManager, "worker-1", "contract")).toBe(false);
    expect(canAccessDocumentType(revokedPayrollManager, "worker-1", "certificate")).toBe(false);
    expect(canAccessDocumentType(revokedMedicalManager, "manager-1", "medical")).toBe(true);
  });

  test("non-admin employee edits reject role and permission fields", () => {
    expect(getForbiddenTeamUpdateFields({ role: "admin", permissions: "{}", phone: "+33600000000" }, false))
      .toEqual(["role", "permissions"]);
  });

  test("admins keep existing ability to update protected schema fields", () => {
    expect(getForbiddenTeamUpdateFields({ role: "manager" }, true)).toEqual([]);
  });

  test("worker name lookups must belong to the caller restaurant", () => {
    expect(workerBelongsToRestaurant({ restaurantId: "resto-1" }, "resto-1")).toBe(true);
    expect(workerBelongsToRestaurant({ restaurantId: "resto-2" }, "resto-1")).toBe(false);
    expect(workerBelongsToRestaurant(null, "resto-1")).toBe(false);
  });

  test("user-scoped resources allow self or TEAM_EDIT", () => {
    const worker = { id: "worker-1", role: "floor" as const, permissions: null };
    const manager = { id: "manager-1", role: "manager" as const, permissions: JSON.stringify({ TEAM_EDIT: true }) };
    const readonlyManager = { id: "manager-2", role: "manager" as const, permissions: JSON.stringify({ TEAM_EDIT: false }) };

    expect(canAccessUserScopedResource(worker, "worker-1")).toBe(true);
    expect(canAccessUserScopedResource(worker, "worker-2")).toBe(false);
    expect(canAccessUserScopedResource(manager, "worker-1")).toBe(true);
    expect(canAccessUserScopedResource(readonlyManager, "worker-1")).toBe(false);
  });

  test("permission override parsing accepts booleans and clears nulls", () => {
    expect(parseManagerPermissionOverrides({ TEAM_EDIT: false, HR_DATA_VIEW: false, HOURS_VIEW: true, BILLING: null }))
      .toEqual({ ok: true, permissions: JSON.stringify({ TEAM_EDIT: false, HR_DATA_VIEW: false, HOURS_VIEW: true }) });
    expect(parseManagerPermissionOverrides({})).toEqual({ ok: true, permissions: null });
  });

  test("permission override parsing rejects unknown or non-boolean values", () => {
    expect(parseManagerPermissionOverrides({ NOPE: true })).toEqual({ ok: false, error: "Permission inconnue: NOPE" });
    expect(parseManagerPermissionOverrides({ TEAM_EDIT: "yes" })).toEqual({ ok: false, error: "TEAM_EDIT doit être true, false ou null" });
  });

  test("production-like registration fails closed without complete Stripe config", () => {
    expect(validateRegistrationBillingConfig({ NODE_ENV: "production", FRONTEND_URL: "https://app.example.com" } as NodeJS.ProcessEnv))
      .toEqual({
        ok: false,
        error: "Stripe registration billing is not configured",
        missing: ["STRIPE_SECRET_KEY", "STRIPE_BASE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"],
        invalid: [],
      });
  });

  test("production-like registration accepts valid Stripe config", () => {
    expect(validateRegistrationBillingConfig({
      NODE_ENV: "production",
      FRONTEND_URL: "https://staging.example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_BASE_PRICE_ID: "price_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
    } as NodeJS.ProcessEnv)).toEqual({ ok: true, bypass: false });
  });

  test("local registration requires explicit billing bypass when Stripe is absent", () => {
    expect(validateRegistrationBillingConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toEqual({ ok: true, bypass: false });
    expect(validateRegistrationBillingConfig({ NODE_ENV: "development", REGISTRATION_BILLING_BYPASS: "true" } as NodeJS.ProcessEnv))
      .toEqual({ ok: true, bypass: true });
  });

  test("Stripe cancellation details are normalized for storage", () => {
    expect(extractStripeCancellationDetails({
      canceled_at: 1_800_000_000,
      cancellation_details: {
        reason: "cancellation_requested",
        feedback: "too_expensive",
        comment: "  Trop cher pour le moment  ",
      },
    } as any)).toEqual({
      cancellationReason: "cancellation_requested",
      cancellationFeedback: "too_expensive",
      cancellationComment: "Trop cher pour le moment",
      cancellationRequestedAt: "2027-01-15T08:00:00.000Z",
    });
  });

  test("token helpers hash raw tokens and redact token-bearing URLs", () => {
    const hashed = hashToken("secret-token");
    expect(isHashedToken(hashed)).toBe(true);
    expect(hashed).not.toContain("secret-token");
    expect(redactSensitiveString("GET /public/onboarding/abc123?x=1 /reset-password?token=def456 /dossier/ghi789"))
      .toBe("GET /public/onboarding/[redacted]?x=1 /reset-password?token=[redacted] /dossier/[redacted]");
  });

  test("demo resource guards reject oversized inputs but allow demo optimization showcase", () => {
    expect(validateDemoAudioUpload({ size: 2 * 1024 * 1024 })).toEqual({ ok: true });
    expect(validateDemoAudioUpload({ size: 2 * 1024 * 1024 + 1 })).toEqual({ ok: false, error: "Audio trop volumineux pour la démo", status: 413 });
    expect(validateDemoMessage("x".repeat(1000))).toEqual({ ok: true });
    expect(validateDemoMessage("x".repeat(1001))).toEqual({ ok: false, error: "Message trop long pour la démo", status: 413 });
    expect(canRunDemoOptimization("demo")).toBe(true);
    expect(canRunDemoOptimization("active")).toBe(true);
  });
});
