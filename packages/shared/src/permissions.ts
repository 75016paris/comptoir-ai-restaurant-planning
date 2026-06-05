// Role-based access control for Comptoir.
//
// Three roles today: admin (account owner / billing entity), manager
// (executive — Responsable, off-schedule), and worker (kitchen | floor).
//
// Permissions are stored on users.permissions as JSON Partial<Record<Permission, boolean>>.
// null = "use role defaults". A non-null override entirely replaces the role
// default for that key. Worker-side actions (read own schedule, request leave,
// etc.) are not gated by this list — they're inherent to having a worker
// account. Permissions here are admin/manager capabilities only.

import type { Role } from "./types.js";

export type Permission =
  | "BILLING"             // Stripe, subscription, billing portal
  | "RESTAURANT_SETTINGS" // HCR grid, sub-roles, profiles, opening days, time-clock toggles
  | "MANAGE_ROLES"        // promote/demote, delete employees, change role
  | "PLANNING_EDIT"       // add/move/remove services on /schedule
  | "PUBLISH_WEEK"        // publish week to team
  | "REPLACEMENT_APPROVE" // resolve a replacement request (pick worker / cancel)
  | "LEAVE_APPROVE"       // approve/reject a leave request
  | "TEAM_VIEW"           // /staff list (employees, contracts, contact)
  | "TEAM_EDIT"           // edit non-sensitive team fields on an employee
  | "HR_DATA_VIEW"        // sensitive HR/admin data (IBAN, NIR, DPAE profile fields)
  | "HR_DATA_EDIT"        // edit sensitive HR/admin data
  | "PAYROLL_VIEW"        // salary/HCR/contract compensation fields
  | "DPAE_EXPORT"         // export URSSAF DPAE data
  | "MEDICAL_DOC_VIEW"    // view/manage medical documents
  | "MANAGER_NOTES_EDIT"  // edit internal manager/admin notes
  | "HOURS_VIEW"          // /hours dashboard (worker hours, OT)
  | "AUDIT_VIEW"          // audit log
  | "OPTIMIZE_RUN";       // auto-staffing solver

export const ALL_PERMISSIONS: Permission[] = [
  "BILLING", "RESTAURANT_SETTINGS", "MANAGE_ROLES",
  "PLANNING_EDIT", "PUBLISH_WEEK",
  "REPLACEMENT_APPROVE", "LEAVE_APPROVE",
  "TEAM_VIEW", "TEAM_EDIT",
  "HR_DATA_VIEW", "HR_DATA_EDIT", "PAYROLL_VIEW", "DPAE_EXPORT", "MEDICAL_DOC_VIEW", "MANAGER_NOTES_EDIT",
  "HOURS_VIEW", "AUDIT_VIEW", "OPTIMIZE_RUN",
];

// Default permissions per role. Admin gets everything. Manager keeps the
// current operational + HR access by default for backward compatibility. Sensitive
// manager access remains individually revocable via users.permissions overrides.
// Workers get nothing from this list (their own page access is not gated here).
const ADMIN_DEFAULTS: Record<Permission, boolean> = {
  BILLING: true,
  RESTAURANT_SETTINGS: true,
  MANAGE_ROLES: true,
  PLANNING_EDIT: true,
  PUBLISH_WEEK: true,
  REPLACEMENT_APPROVE: true,
  LEAVE_APPROVE: true,
  TEAM_VIEW: true,
  TEAM_EDIT: true,
  HR_DATA_VIEW: true,
  HR_DATA_EDIT: true,
  PAYROLL_VIEW: true,
  DPAE_EXPORT: true,
  MEDICAL_DOC_VIEW: true,
  MANAGER_NOTES_EDIT: true,
  HOURS_VIEW: true,
  AUDIT_VIEW: true,
  OPTIMIZE_RUN: true,
};

const MANAGER_DEFAULTS: Record<Permission, boolean> = {
  BILLING: false,
  RESTAURANT_SETTINGS: false,
  MANAGE_ROLES: false,
  PLANNING_EDIT: true,
  PUBLISH_WEEK: true,
  REPLACEMENT_APPROVE: true,
  LEAVE_APPROVE: true,
  TEAM_VIEW: true,
  TEAM_EDIT: true,
  HR_DATA_VIEW: true,
  HR_DATA_EDIT: true,
  PAYROLL_VIEW: true,
  DPAE_EXPORT: true,
  MEDICAL_DOC_VIEW: true,
  MANAGER_NOTES_EDIT: true,
  HOURS_VIEW: true,
  AUDIT_VIEW: true,
  OPTIMIZE_RUN: true,
};

const WORKER_DEFAULTS: Record<Permission, boolean> = {
  BILLING: false,
  RESTAURANT_SETTINGS: false,
  MANAGE_ROLES: false,
  PLANNING_EDIT: false,
  PUBLISH_WEEK: false,
  REPLACEMENT_APPROVE: false,
  LEAVE_APPROVE: false,
  TEAM_VIEW: false,
  TEAM_EDIT: false,
  HR_DATA_VIEW: false,
  HR_DATA_EDIT: false,
  PAYROLL_VIEW: false,
  DPAE_EXPORT: false,
  MEDICAL_DOC_VIEW: false,
  MANAGER_NOTES_EDIT: false,
  HOURS_VIEW: false,
  AUDIT_VIEW: false,
  OPTIMIZE_RUN: false,
};

export const ROLE_DEFAULTS: Record<Role, Record<Permission, boolean>> = {
  admin: ADMIN_DEFAULTS,
  manager: MANAGER_DEFAULTS,
  kitchen: WORKER_DEFAULTS,
  floor: WORKER_DEFAULTS,
};

// Parse the JSON-stringified overrides. Defensively returns {} on any error.
export function parsePermissions(raw: string | null | undefined): Partial<Record<Permission, boolean>> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

// Resolve a permission for a user. Override (when present) wins over the role
// default. Both values must be booleans; anything else falls through to the
// role default.
export function can(
  user: { role: Role; permissions: string | null },
  action: Permission,
): boolean {
  const overrides = parsePermissions(user.permissions);
  const override = overrides[action];
  if (typeof override === "boolean") return override;
  return ROLE_DEFAULTS[user.role][action];
}

// Build an effective permission map (defaults merged with overrides). Useful
// for the Profil page checklist UI: shows the resolved value of each key
// alongside whether it's coming from the role default or an explicit override.
export function effectivePermissions(
  user: { role: Role; permissions: string | null },
): Record<Permission, { value: boolean; source: "default" | "override" }> {
  const overrides = parsePermissions(user.permissions);
  const result = {} as Record<Permission, { value: boolean; source: "default" | "override" }>;
  for (const p of ALL_PERMISSIONS) {
    const override = overrides[p];
    if (typeof override === "boolean") {
      result[p] = { value: override, source: "override" };
    } else {
      result[p] = { value: ROLE_DEFAULTS[user.role][p], source: "default" };
    }
  }
  return result;
}
