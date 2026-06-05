import { Hono } from "hono";
import { type AppEnv } from "../middleware/auth.js";
import { db } from "../db/connection.js";
import {
  users, restaurants, documents, workerAvailability, workerRestrictions, workerPreferredSchedule,
  services, replacementRequests, holidayRequests, timeClocks, notifications, sessions,
  passwordResetTokens, ownerMemberships, restaurantMemberships, workerRestaurantProfiles,
} from "../db/schema.js";
import { randomBytes } from "node:crypto";
import { eq, and, or, ne, gte, lte, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin, requirePermission, requireActiveSubscription } from "../middleware/auth.js";
import { requestRestaurant } from "../middleware/request-restaurant.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { hash, verify } from "argon2";
import { can, createUserSchema, updateUserSchema, selfUpdateUserSchema, upsertAvailabilitySchema, upsertRestrictionsSchema, ALL_PERMISSIONS, type Permission, type Role, flattenZodError } from "@comptoir/shared";
import { DEFAULT_CONTRACT_HOURS } from "@comptoir/shared";
import { hashToken } from "../utils/token-security.js";
import { bumpCacheVersion } from "../services/baseline-cache.js";
import { createOnboardingToken } from "../services/onboarding-tokens.js";
import { listRestaurantMemberUserIds, listSchedulingRosterWorkers, userHasActiveRestaurantMembership, userHasRestaurantMembership } from "../services/restaurant-context.js";
import {
  InvalidUploadError,
  StorageInactiveError,
  commitUploadedObject,
  deleteStoredObject,
  presignDocumentDownload,
  presignDocumentUpload,
} from "../services/document-uploads.js";


const passwordChangeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: "Trop de tentatives. Réessayez dans 15 minutes." });
const generateTemporaryPassword = () => randomBytes(12).toString("hex");
const ownerRoleForTeamRole = (role: Role) => role === "admin" ? "owner_admin" : role === "manager" ? "owner_manager" : "member";

// Kitchen/floor workers must have at least one sub-role so the planner and
// optimizer can target them by position. Managers/admins don't carry sub-roles.
const ROLES_REQUIRING_SUBROLES = new Set(["kitchen", "floor"]);
function subRolesMissingForRole(role: string | undefined, subRoles: string[] | undefined): boolean {
  if (!role || !ROLES_REQUIRING_SUBROLES.has(role)) return false;
  return !subRoles || subRoles.length === 0;
}
const SUBROLES_REQUIRED_ERROR = "Au moins un poste (sous-rôle) est requis pour un employé cuisine ou salle.";
const PROTECTED_TEAM_UPDATE_FIELDS = new Set([
  "role",
  "permissions",
  "active",
  "inactiveFrom",
  "inactiveUntil",
  "password",
  "passwordHash",
  "mustChangePassword",
]);

const HR_DATA_FIELDS = new Set([
  "address",
  "iban",
  "startDate",
  "emergencyContact",
  "emergencyPhone",
  "dateOfBirth",
  "birthPlace",
  "nationality",
  "nir",
  "matricule",
]);

const PAYROLL_FIELDS = new Set([
  "contractType",
  "contractEndDate",
  "contractHours",
  "maxWeeklyHours",
  "adminOtOverride",
  "hcrLevel",
  "hourlyRate",
  "rateEffectiveFrom",
]);

const MANAGER_NOTES_FIELDS = new Set(["managerNotes"]);

type UserPermissionContext = { id: string; role: Role; permissions: string | null };

export function getForbiddenTeamUpdateFields(body: unknown, isAdmin: boolean): string[] {
  if (isAdmin || !body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).filter((key) => PROTECTED_TEAM_UPDATE_FIELDS.has(key));
}

export function getForbiddenSensitiveTeamUpdateFields(body: unknown, user: UserPermissionContext): string[] {
  if (user.role === "admin" || !body || typeof body !== "object" || Array.isArray(body)) return [];
  const forbidden: string[] = [];
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (HR_DATA_FIELDS.has(key) && !can(user, "HR_DATA_EDIT")) forbidden.push(key);
    else if (PAYROLL_FIELDS.has(key) && !can(user, "PAYROLL_VIEW")) forbidden.push(key);
    else if (MANAGER_NOTES_FIELDS.has(key) && !can(user, "MANAGER_NOTES_EDIT")) forbidden.push(key);
  }
  return forbidden;
}

export function sanitizeUserForViewer<T extends Record<string, unknown>>(row: T, viewer: UserPermissionContext, isSelf = false): T {
  if (viewer.role !== "manager" || isSelf) return row;
  const out = { ...row } as Record<string, unknown>;
  if (!can(viewer, "HR_DATA_VIEW")) {
    for (const field of HR_DATA_FIELDS) delete out[field];
  }
  if (!can(viewer, "PAYROLL_VIEW")) {
    for (const field of PAYROLL_FIELDS) delete out[field];
  }
  if (!can(viewer, "MANAGER_NOTES_EDIT")) {
    for (const field of MANAGER_NOTES_FIELDS) delete out[field];
  }
  return out as T;
}

export function canAccessUserScopedResource(user: UserPermissionContext, targetUserId: string): boolean {
  return user.id === targetUserId || can(user, "TEAM_EDIT");
}

export function canAccessDocumentType(user: UserPermissionContext, targetUserId: string, type: string): boolean {
  if (user.id === targetUserId) return true;
  if (type === "medical") return can(user, "MEDICAL_DOC_VIEW");
  return can(user, "HR_DATA_VIEW") && can(user, "PAYROLL_VIEW");
}

function sanitizeChecklistForViewer<T extends {
  items: Array<{ category: string; mandatory: boolean; status: string; expiresAt?: string | null }>;
  mandatoryTotal: number;
  mandatoryValid: number;
  percentComplete: number;
  readyForDpae: boolean;
  expiringWithin30d: number;
  pendingReview: number;
}>(checklist: T, viewer: UserPermissionContext, targetUserId: string): T {
  if (canAccessDocumentType(viewer, targetUserId, "medical")) return checklist;
  const items = checklist.items.filter((i) => i.category !== "medical");
  const mandatoryTotal = items.filter((i) => i.mandatory).length;
  const mandatoryValid = items.filter((i) => i.mandatory && (i.status === "valid" || i.status === "expiring_soon")).length;
  return {
    ...checklist,
    items,
    mandatoryTotal,
    mandatoryValid,
    percentComplete: mandatoryTotal > 0 ? Math.round((mandatoryValid / mandatoryTotal) * 100) : 100,
    readyForDpae: mandatoryValid === mandatoryTotal,
    expiringWithin30d: items.filter((i) => i.status === "expiring_soon").length,
    pendingReview: items.filter((i) => i.status === "pending_review").length,
  };
}

export function parseManagerPermissionOverrides(body: unknown):
  | { ok: true; permissions: string | null }
  | { ok: false; error: string } {
  const incoming = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const overrides: Partial<Record<Permission, boolean>> = {};
  for (const key of Object.keys(incoming)) {
    if (!ALL_PERMISSIONS.includes(key as Permission)) {
      return { ok: false, error: `Permission inconnue: ${key}` };
    }
    const value = incoming[key];
    if (value === null) continue; // null = clear, leave key out of overrides
    if (typeof value !== "boolean") {
      return { ok: false, error: `${key} doit être true, false ou null` };
    }
    overrides[key as Permission] = value;
  }
  return { ok: true, permissions: Object.keys(overrides).length === 0 ? null : JSON.stringify(overrides) };
}

export const userRoutes = new Hono<AppEnv>();

userRoutes.use("*", requireAuth);

/** Parse subRoles JSON string from DB into array */
function parseSubRoles(row: Record<string, unknown>): Record<string, unknown> {
  if (row && typeof row.subRoles === "string") {
    try { row.subRoles = JSON.parse(row.subRoles); } catch { row.subRoles = []; }
  }
  return row;
}

function serviceHours(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  if (minutes < 0) minutes += 24 * 60;
  return minutes / 60;
}
userRoutes.use("*", requireActiveSubscription);

// Verify a user ID belongs to the caller's restaurant. Returns true or sends 404.
function verifyUserInRestaurant(userId: string, restaurantId: string): boolean {
  const [row] = db.select({ id: users.id }).from(users)
    .where(and(eq(users.id, userId), eq(users.active, true)))
    .limit(1).all();
  return !!row && userHasActiveRestaurantMembership(userId, restaurantId);
}

function verifyUserMembershipInRestaurant(userId: string, restaurantId: string): boolean {
  const [row] = db.select({ id: users.id }).from(users)
    .where(eq(users.id, userId))
    .limit(1).all();
  return !!row && userHasRestaurantMembership(userId, restaurantId);
}

// Worker coworker view — scheduling identity only. Self-profile still uses userSelect.
export const workerUserSelect = {
  id: users.id,
  name: users.name,
  role: users.role,
  subRole: users.subRole,
  subRoles: users.subRoles,
  active: users.active,
} as const;

// Admin view — includes sensitive fields (but not managerNotes)
const userSelect = {
  id: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  role: users.role,
  priority: users.priority,
  address: users.address,
  iban: users.iban,
  startDate: users.startDate,
  emergencyContact: users.emergencyContact,
  emergencyPhone: users.emergencyPhone,
  dateOfBirth: users.dateOfBirth,
  birthPlace: users.birthPlace,
  nationality: users.nationality,
  nir: users.nir,
  notes: users.notes,
  subRole: users.subRole,
  subRoles: users.subRoles,
  overtimeWilling: users.overtimeWilling,
  coupureWilling: users.coupureWilling,
  multiRestaurantWilling: users.multiRestaurantWilling,
  matricule: users.matricule,
  contractType: users.contractType,
  contractEndDate: users.contractEndDate,
  contractHours: users.contractHours,
  maxWeeklyHours: users.maxWeeklyHours,
  adminOtOverride: users.adminOtOverride,
  active: users.active,
  inactiveFrom: users.inactiveFrom,
  inactiveUntil: users.inactiveUntil,
  hcrLevel: users.hcrLevel,
  hourlyRate: users.hourlyRate,
} as const;

// Admin gets managerNotes too
const adminUserSelect = {
  ...userSelect,
  managerNotes: users.managerNotes,
} as const;

// GET /users/dossier-status — restaurant-wide dossier summary for nav + staff
// list badges. One row per non-admin worker; cheap because computeWorkerChecklist
// only reads a handful of docs per worker. Registered before /:id so the
// literal "dossier-status" path doesn't get matched as a user id.
userRoutes.get("/dossier-status", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "TEAM_EDIT")) return c.json({ data: { workers: [], totalPendingReview: 0, totalIncompleteDossiers: 0 } });

  const workerIds = listRestaurantMemberUserIds(restaurant.restaurantId, { roles: ["manager", "kitchen", "floor"] });
  const workers = workerIds.length > 0
    ? db.select({ id: users.id, role: users.role })
      .from(users)
      .where(and(inArray(users.id, workerIds), ne(users.role, "admin")))
      .all()
    : [];

  const { computeWorkerChecklist } = await import("../services/onboarding-checklist.js");
  const rows: Array<{ workerId: string; pendingReview: number; missingMandatory: number; readyForDpae: boolean }> = [];
  let totalPendingReview = 0;
  let totalIncompleteDossiers = 0;
  for (const w of workers) {
    const cl = sanitizeChecklistForViewer(computeWorkerChecklist(w.id, restaurant.restaurantId), user, w.id);
    const missingMandatory = (cl.mandatoryTotal - cl.mandatoryValid) + cl.missingProfileFields.length;
    rows.push({ workerId: w.id, pendingReview: cl.pendingReview, missingMandatory, readyForDpae: cl.readyForDpae });
    totalPendingReview += cl.pendingReview;
    if (!cl.readyForDpae) totalIncompleteDossiers++;
  }
  return c.json({ data: { workers: rows, totalPendingReview, totalIncompleteDossiers } });
});

// GET /users/checklist/expiring — admins/managers see the team-wide docs report.
userRoutes.get("/checklist/expiring", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "TEAM_VIEW")) return c.json({ error: "Forbidden" }, 403);
  const { computeExpiringDocsReport } = await import("../services/onboarding-checklist.js");
  try {
    const report = computeExpiringDocsReport(restaurant.restaurantId);
    return c.json({ data: can(user, "MEDICAL_DOC_VIEW") ? report : report.filter((r) => r.requirementKey !== "medical_cert") });
  } catch (e: any) {
    return c.json({ error: e?.message || "report failed" }, 500);
  }
});

// GET /users — ?include=inactive to also show deactivated workers (admin/manager).
// adminUserSelect (with managerNotes) is admin-only — managerNotes is admin's
// private notes about employees and shouldn't leak to managers themselves.
userRoutes.get("/", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const includeInactive = c.req.query("include") === "inactive" && can(user, "TEAM_VIEW");
  const select = user.role === "admin"
    ? adminUserSelect
    : can(user, "TEAM_VIEW") ? userSelect : workerUserSelect;

  const memberIds = listRestaurantMemberUserIds(restaurant.restaurantId, { includeInactiveUsers: includeInactive });
  if (memberIds.length === 0) return c.json({ data: [] });

  const result = db
    .select(select)
    .from(users)
    .where(inArray(users.id, memberIds))
    .all();

  return c.json({ data: result.map(r => {
    const row = parseSubRoles(r as Record<string, unknown>);
    return sanitizeUserForViewer(row, user, row.id === user.id);
  }) });
});

// GET /users/scheduling-roster — scheduling identity for the active restaurant.
// Includes accepted same-owner shared workers, but not HR/payroll/document fields.
userRoutes.get("/scheduling-roster", async (c) => {
  const user = c.get("user");
  if (!can(user, "TEAM_VIEW")) return c.json({ error: "Forbidden" }, 403);
  const restaurant = requestRestaurant(c);
  const roster = listSchedulingRosterWorkers(restaurant.restaurantId, ["kitchen", "floor"]);
  const from = c.req.query("from");
  const to = c.req.query("to");
  const hoursByWorker = new Map<string, number>();
  const workerIds = roster.map((row) => row.id);
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && workerIds.length > 0) {
    const rows = db
      .select({
        workerId: services.workerId,
        startTime: services.startTime,
        endTime: services.endTime,
      })
      .from(services)
      .innerJoin(restaurants, eq(restaurants.id, services.restaurantId))
      .where(and(
        eq(restaurants.ownerId, restaurant.ownerId),
        inArray(services.workerId, workerIds),
        gte(services.date, from),
        lte(services.date, to),
        ne(services.status, "cancelled"),
      ))
      .all();
    for (const row of rows) {
      hoursByWorker.set(row.workerId, (hoursByWorker.get(row.workerId) ?? 0) + serviceHours(row.startTime, row.endTime));
    }
  }
  return c.json({
    data: roster.map((row) => {
      const { maxWeeklyHours: _maxWeeklyHours, ...safeRow } = row;
      const weeklyHours = hoursByWorker.has(row.id) ? Math.round((hoursByWorker.get(row.id) ?? 0) * 10) / 10 : undefined;
      return parseSubRoles({ ...safeRow, email: "", phone: "", weeklyHours });
    }),
  });
});

// GET /users/:id
userRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  // Workers see full PII only for themselves, limited view for others.
  // Manager sees full PII (userSelect) of every employee; admin additionally sees managerNotes.
  const isSelf = user.id === id;
  const select = user.role === "admin" ? adminUserSelect
    : (can(user, "TEAM_VIEW") || isSelf) ? userSelect
    : workerUserSelect;

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "User not found" }, 404);
  }

  const [result] = db
    .select(select)
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }
  parseSubRoles(result as Record<string, unknown>);

  return c.json({ data: sanitizeUserForViewer(result as Record<string, unknown>, user, isSelf) });
});

// POST /users — create new worker (admin only)
userRoutes.post("/", requireAdmin, async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const body = await c.req.json();
  const parsed = createUserSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  if (subRolesMissingForRole(parsed.data.role, parsed.data.subRoles)) {
    return c.json({ error: SUBROLES_REQUIRED_ERROR }, 400);
  }

  const [existing] = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1)
    .all();

  if (existing) {
    return c.json({ error: "Email already in use" }, 409);
  }

  const temporaryPassword = parsed.data.password ? null : generateTemporaryPassword();
  const password = parsed.data.password || temporaryPassword!;
  const passwordHash = await hash(password);
  // First-login gate: if the admin didn't choose a password, the worker got a
  // one-time temporary password and must change it before using the app (id:8c1d).
  const mustChangePassword = !parsed.data.password;

  const firstName = parsed.data.firstName?.trim() || null;
  const lastName = parsed.data.lastName?.trim() || null;
  const fullName = (firstName || lastName)
    ? [firstName, lastName].filter(Boolean).join(" ")
    : parsed.data.name?.trim();
  if (!fullName) {
    return c.json({ error: "Prénom et nom requis" }, 400);
  }
  const restaurantDefaults = db.select({ defaultContractHours: restaurants.defaultContractHours })
    .from(restaurants)
    .where(eq(restaurants.id, restaurant.restaurantId))
    .limit(1)
    .get();
  const shouldDefaultContractHours =
    (parsed.data.role === "kitchen" || parsed.data.role === "floor") &&
    parsed.data.contractType !== "extra" &&
    parsed.data.contractHours == null;
  const contractHours = shouldDefaultContractHours
    ? (restaurantDefaults?.defaultContractHours ?? DEFAULT_CONTRACT_HOURS)
    : (parsed.data.contractHours ?? null);

  const [created] = db.transaction((tx) => {
    const [created] = tx
      .insert(users)
      .values({
      name: fullName,
      firstName,
      lastName,
      email: parsed.data.email,
      phone: parsed.data.phone,
      role: parsed.data.role,
      priority: parsed.data.priority ?? 1,
      passwordHash,
      mustChangePassword,
      restaurantId: restaurant.restaurantId,
      address: parsed.data.address ?? null,
      iban: parsed.data.iban ?? null,
      startDate: parsed.data.startDate ?? null,
      emergencyContact: parsed.data.emergencyContact ?? null,
      emergencyPhone: parsed.data.emergencyPhone ?? null,
      dateOfBirth: parsed.data.dateOfBirth ?? null,
      birthPlace: parsed.data.birthPlace ?? null,
      nationality: parsed.data.nationality ?? null,
      nir: parsed.data.nir ?? null,
      notes: parsed.data.notes ?? null,
      managerNotes: parsed.data.managerNotes ?? null,
      subRole: parsed.data.subRole ?? null,
      subRoles: parsed.data.subRoles ? JSON.stringify(parsed.data.subRoles) : "[]",
      contractType: parsed.data.contractType ?? null,
      contractEndDate: parsed.data.contractEndDate ?? null,
      contractHours,
      overtimeWilling: parsed.data.overtimeWilling ?? false,
      coupureWilling: parsed.data.coupureWilling ?? false,
      multiRestaurantWilling: parsed.data.multiRestaurantWilling ?? (parsed.data.role === "kitchen" || parsed.data.role === "floor"),
      hourlyRate: parsed.data.hourlyRate ?? null,
      hcrLevel: parsed.data.hcrLevel ?? null,
      rateEffectiveFrom: parsed.data.rateEffectiveFrom ?? parsed.data.startDate ?? null,
    })
    .returning()
    .all();

    tx.insert(ownerMemberships).values({
      ownerId: restaurant.ownerId,
      userId: created.id,
      role: ownerRoleForTeamRole(created.role as Role),
    }).onConflictDoNothing().run();

    tx.insert(restaurantMemberships).values({
      restaurantId: restaurant.restaurantId,
      userId: created.id,
      role: created.role,
      permissions: created.permissions,
      active: true,
    }).onConflictDoNothing().run();

    if (created.role === "kitchen" || created.role === "floor") {
      tx.insert(workerRestaurantProfiles).values({
        restaurantId: restaurant.restaurantId,
        userId: created.id,
        priority: created.priority,
        subRoles: created.subRoles,
        contractType: created.contractType,
        contractHours: created.contractHours,
        contractEndDate: created.contractEndDate,
        maxWeeklyHours: created.maxWeeklyHours,
        adminOtOverride: created.adminOtOverride,
        hcrLevel: created.hcrLevel,
        hourlyRate: created.hourlyRate,
        matricule: created.matricule,
        managerNotes: created.managerNotes,
        multiRestaurantWilling: created.multiRestaurantWilling,
      }).onConflictDoNothing().run();
    }

    return [created];
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({
    data: {
      id: created.id,
      name: created.name,
      email: created.email,
      phone: created.phone,
      role: created.role,
      ...(temporaryPassword ? { temporaryPassword } : {}),
    },
  }, 201);
});

// PATCH /users/:id — update worker. Admins can update all schema fields;
// managers need TEAM_EDIT and cannot change role/permission/account-state fields.
userRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (user.role !== "admin" && !can(user, "TEAM_EDIT")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const id = c.req.param("id");
  const body = await c.req.json();
  const forbidden = getForbiddenTeamUpdateFields(body, user.role === "admin");
  if (forbidden.length > 0) {
    return c.json({ error: "Forbidden — protected fields", fields: forbidden }, 403);
  }
  const forbiddenSensitive = getForbiddenSensitiveTeamUpdateFields(body, user);
  if (forbiddenSensitive.length > 0) {
    return c.json({ error: "Forbidden — sensitive fields", fields: forbiddenSensitive }, 403);
  }
  if (body && typeof body === "object" && !Array.isArray(body) && "multiRestaurantWilling" in body && id !== user.id) {
    return c.json({ error: "Ce choix doit être modifié par le salarié depuis son espace personnel." }, 403);
  }

  const parsed = updateUserSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "User not found" }, 404);
  }

  if (parsed.data.email) {
    const [existing] = db.select({ id: users.id }).from(users)
      .where(eq(users.email, parsed.data.email)).limit(1).all();
    if (existing && existing.id !== id) {
      return c.json({ error: "Cet e-mail est déjà utilisé" }, 409);
    }
  }

  // Validate that the final (post-patch) state still has at least one sub-role
  // for kitchen/floor workers. We only need to read the current row when the
  // patch doesn't fully specify both fields.
  if (parsed.data.role !== undefined || parsed.data.subRoles !== undefined) {
    const [current] = db.select({ role: users.role, subRoles: users.subRoles })
      .from(users)
      .where(eq(users.id, id))
      .limit(1).all();
    if (current) {
      const finalRole = parsed.data.role ?? current.role;
      let finalSubRoles: string[];
      if (parsed.data.subRoles !== undefined) {
        finalSubRoles = parsed.data.subRoles;
      } else {
        try { finalSubRoles = JSON.parse(current.subRoles || "[]"); } catch { finalSubRoles = []; }
      }
      if (subRolesMissingForRole(finalRole, finalSubRoles)) {
        return c.json({ error: SUBROLES_REQUIRED_ERROR }, 400);
      }
    }
  }

  const setData: Record<string, unknown> = { ...parsed.data };
  if (setData.subRoles !== undefined) {
    setData.subRoles = JSON.stringify(setData.subRoles);
  }
  // Recompute canonical full name when either part changes.
  if (setData.firstName !== undefined || setData.lastName !== undefined) {
    const [current] = db.select({ firstName: users.firstName, lastName: users.lastName, name: users.name })
      .from(users).where(eq(users.id, id)).limit(1).all();
    const fn = (setData.firstName !== undefined ? setData.firstName as string | null : current?.firstName) || null;
    const ln = (setData.lastName !== undefined ? setData.lastName as string | null : current?.lastName) || null;
    const computed = [fn, ln].filter(Boolean).join(" ").trim();
    if (computed) setData.name = computed;
  }

  const [updated] = db
    .update(users)
    .set(setData)
    .where(eq(users.id, id))
    .returning()
    .all();

  if (!updated) {
    return c.json({ error: "User not found" }, 404);
  }

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({
    data: sanitizeUserForViewer({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      role: updated.role,
      priority: updated.priority,
      address: updated.address,
      iban: updated.iban,
      startDate: updated.startDate,
      emergencyContact: updated.emergencyContact,
      emergencyPhone: updated.emergencyPhone,
      notes: updated.notes,
      managerNotes: updated.managerNotes,
      subRole: updated.subRole,
      subRoles: updated.subRoles,
      overtimeWilling: updated.overtimeWilling,
      matricule: updated.matricule,
      contractType: updated.contractType,
      contractEndDate: updated.contractEndDate,
      contractHours: updated.contractHours,
      maxWeeklyHours: updated.maxWeeklyHours,
      adminOtOverride: updated.adminOtOverride,
      coupureWilling: updated.coupureWilling,
      multiRestaurantWilling: updated.multiRestaurantWilling,
      hcrLevel: updated.hcrLevel,
      hourlyRate: updated.hourlyRate,
    }, user, updated.id === user.id),
  });
});

// PATCH /users/me — self-update (worker edits own profile)
userRoutes.patch("/me/profile", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = selfUpdateUserSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  // Zod strips unknown fields — if nothing valid remains, return early
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: "Aucun champ modifiable fourni" }, 400);
  }

  // Check email uniqueness if changing email
  if (parsed.data.email && parsed.data.email !== user.email) {
    const [existing] = db.select({ id: users.id }).from(users)
      .where(eq(users.email, parsed.data.email)).limit(1).all();
    if (existing) {
      return c.json({ error: "Cet e-mail est déjà utilisé" }, 409);
    }
  }

  const [updated] = db
    .update(users)
    .set(parsed.data)
    .where(eq(users.id, user.id))
    .returning()
    .all();

  if (!updated) {
    return c.json({ error: "Update failed" }, 500);
  }

  return c.json({
    data: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      role: updated.role,
      address: updated.address,
      iban: updated.iban,
      startDate: updated.startDate,
      emergencyContact: updated.emergencyContact,
      emergencyPhone: updated.emergencyPhone,
      dateOfBirth: updated.dateOfBirth,
      birthPlace: updated.birthPlace,
      nationality: updated.nationality,
      nir: updated.nir,
      notes: updated.notes,
      overtimeWilling: updated.overtimeWilling,
      maxWeeklyHours: updated.maxWeeklyHours,
      coupureWilling: updated.coupureWilling,
      multiRestaurantWilling: updated.multiRestaurantWilling,
    },
  });
});

// PATCH /users/me/password — self-service password change (id:4a2f).
// Requires the current password (argon2 verify) before replacing the hash, invalidates all
// sessions except the caller's, and clears the must_change_password gate (id:8c1d).
userRoutes.patch("/me/password", passwordChangeLimiter, async (c) => {
  const user = c.get("user");
  const { currentPassword, newPassword } = await c.req.json().catch(() => ({}));

  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return c.json({ error: "Mot de passe actuel et nouveau mot de passe requis" }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "Le mot de passe doit contenir au moins 8 caractères" }, 400);
  }
  if (newPassword === currentPassword) {
    return c.json({ error: "Le nouveau mot de passe doit être différent de l'ancien" }, 400);
  }

  const [row] = db.select({ passwordHash: users.passwordHash }).from(users)
    .where(eq(users.id, user.id)).limit(1).all();
  if (!row) {
    return c.json({ error: "Utilisateur introuvable" }, 404);
  }

  const valid = await verify(row.passwordHash, currentPassword);
  if (!valid) {
    return c.json({ error: "Mot de passe actuel incorrect" }, 401);
  }

  const passwordHash = await hash(newPassword);
  db.update(users)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(users.id, user.id))
    .run();

  // Invalidate all OTHER sessions for this user (keep the caller logged in).
  const sessionId = c.req.header("cookie")?.match(/session=([^;]+)/)?.[1];
  if (sessionId) {
    db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, sessionId))).run();
  } else {
    db.delete(sessions).where(eq(sessions.userId, user.id)).run();
  }

  return c.json({ data: { ok: true } });
});

// ── Documents ──

// POST /users/dpae/export — generate a DPAE CSV for one or more workers.
// Body: { workerIds: string[], perWorker?: { [workerId]: { nir?, birthDate?, birthPlace?, nationality? } } }
// Returns CSV text the admin can download and upload to URSSAF net-entreprises.
userRoutes.post("/dpae/export", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "DPAE_EXPORT")) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const workerIds = Array.isArray(body.workerIds) ? body.workerIds as string[] : [];
  if (workerIds.length === 0) return c.json({ error: "workerIds is required" }, 400);
  try {
    const { generateDpaeRows, rowsToCsv } = await import("../services/dpae-export.js");
    const rows = generateDpaeRows({ restaurantId: restaurant.restaurantId, workerIds, perWorker: body.perWorker });
    const csv = rowsToCsv(rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dpae-${new Date().toISOString().slice(0,10)}.csv"`,
      },
    });
  } catch (e: any) {
    return c.json({ error: e?.message || "DPAE export failed" }, 500);
  }
});

// POST /users/:id/generate-contract — render a contract template filled with worker/restaurant data.
// Returns HTML the admin can preview / print to PDF. Optionally saves to documents when save=true.
userRoutes.post("/:id/generate-contract", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  if (!can(user, "TEAM_EDIT") || !can(user, "HR_DATA_VIEW") || !can(user, "PAYROLL_VIEW")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) return c.json({ error: "Employé non trouvé" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const kind = body.kind as "CDI" | "CDD" | "saisonnier" | "extra" | undefined;
  if (!kind || !["CDI", "CDD", "saisonnier", "extra"].includes(kind)) {
    return c.json({ error: "kind must be CDI | CDD | saisonnier | extra" }, 400);
  }
  try {
    const { renderContract } = await import("../services/contract-templates.js");
    const { html, tokens } = renderContract(restaurant.restaurantId, userId, kind, body.inputs || {}, body.templateId);
    // Optional persistence as document
    if (body.save === true) {
      const base64 = Buffer.from(html, "utf8").toString("base64");
      const nowIso = new Date().toISOString();
      db.insert(documents).values({
        userId,
        restaurantId: restaurant.restaurantId,
        name: `Contrat ${kind} — ${tokens["today"]}`,
        type: "contract",
        filename: `contrat-${kind}-${userId.slice(0,8)}.html`,
        mimeType: "text/html",
        size: html.length,
        data: base64,
        uploadedBy: user.id,
        reviewedAt: nowIso,
        reviewedBy: user.id,
      }).run();
    }
    return c.json({ data: { html, tokens, saved: !!body.save } });
  } catch (e: any) {
    return c.json({ error: e?.message || "contract generation failed" }, 500);
  }
});

// POST /users/:id/login-invite — email worker a password setup link for web access only.
userRoutes.post("/:id/login-invite", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  if (!can(user, "TEAM_EDIT")) return c.json({ error: "Forbidden" }, 403);
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) return c.json({ error: "Employé non trouvé" }, 404);

  const [target] = db.select({ name: users.name, email: users.email }).from(users)
    .where(eq(users.id, userId)).limit(1).all();
  if (!target?.email || target.email.endsWith("@noemail.local")) {
    return c.json({ error: "Aucune adresse email pour cet employé" }, 400);
  }

  const [resto] = db.select({ name: restaurants.name }).from(restaurants)
    .where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();

  const passwordToken = randomBytes(32).toString("hex");
  const passwordExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.insert(passwordResetTokens).values({ userId, token: hashToken(passwordToken), expiresAt: passwordExpiresAt }).run();

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const passwordSetupUrl = `${frontendUrl}/reset-password?token=${passwordToken}`;

  const { sendWorkerAccountSetupEmail } = await import("../services/email.js");
  const sent = await sendWorkerAccountSetupEmail(target.email, target.name, resto?.name || "Comptoir", passwordSetupUrl);
  return c.json({ data: { sent } });
});

// POST /users/:id/invite — email worker an invitation to complete their self-service dossier.
// The body dynamically reflects what's actually missing: unfilled profile fields
// (adresse/IBAN/contact d'urgence) + mandatory checklist docs not yet uploaded.
userRoutes.post("/:id/invite", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  if (!can(user, "TEAM_EDIT")) return c.json({ error: "Forbidden" }, 403);
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) return c.json({ error: "Employé non trouvé" }, 404);

  const [target] = db.select({
    name: users.name,
    email: users.email,
    address: users.address,
    iban: users.iban,
    emergencyContact: users.emergencyContact,
    emergencyPhone: users.emergencyPhone,
    dateOfBirth: users.dateOfBirth,
    birthPlace: users.birthPlace,
    nationality: users.nationality,
    nir: users.nir,
  }).from(users)
    .where(eq(users.id, userId)).limit(1).all();
  if (!target?.email) return c.json({ error: "Aucune adresse email pour cet employé" }, 400);

  const [resto] = db.select({ name: restaurants.name }).from(restaurants)
    .where(eq(restaurants.id, restaurant.restaurantId)).limit(1).all();

  const personalInfoNeeded: string[] = [];
  if (!target.address) personalInfoNeeded.push("Adresse postale");
  if (!target.iban) personalInfoNeeded.push("IBAN (pour le virement de la paie)");
  if (!target.emergencyContact || !target.emergencyPhone) personalInfoNeeded.push("Contact d'urgence (nom + téléphone)");
  if (!target.dateOfBirth) personalInfoNeeded.push("Date de naissance (DPAE)");
  if (!target.birthPlace) personalInfoNeeded.push("Lieu de naissance (DPAE)");
  if (!target.nationality) personalInfoNeeded.push("Nationalité (DPAE)");
  if (!target.nir) personalInfoNeeded.push("Numéro de sécurité sociale — NIR (DPAE, facultatif si non encore attribué)");

  let missingDocs: Array<{ label: string; description: string }> = [];
  try {
    const { computeWorkerChecklist } = await import("../services/onboarding-checklist.js");
    const checklist = sanitizeChecklistForViewer(computeWorkerChecklist(userId, restaurant.restaurantId), user, userId);
    missingDocs = checklist.items
      .filter((i) => i.mandatory && i.status === "missing")
      .map((i) => ({ label: i.label, description: i.description }));
  } catch {
    // Checklist failure shouldn't block the invite — fall back to no document section.
  }

  // Mint a fresh 72h magic-link token. Re-inviting revokes older dossier links
  // for the worker so forwarded/stale emails stop working immediately.
  const { token } = createOnboardingToken(userId, restaurant.restaurantId);

  // Also mint a password setup link so the invite never exposes a shared provisional password.
  const passwordToken = randomBytes(32).toString("hex");
  const passwordExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.insert(passwordResetTokens).values({ userId, token: hashToken(passwordToken), expiresAt: passwordExpiresAt }).run();

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const onboardingUrl = `${frontendUrl}/dossier/${token}`;
  const passwordSetupUrl = `${frontendUrl}/reset-password?token=${passwordToken}`;

  const { sendWorkerInvitationEmail } = await import("../services/email.js");
  const sent = await sendWorkerInvitationEmail(
    target.email,
    target.name,
    resto?.name || "Comptoir",
    { personalInfoNeeded, missingDocs, onboardingUrl, passwordSetupUrl },
  );
  return c.json({ data: { sent, personalInfoNeeded: personalInfoNeeded.length, missingDocs: missingDocs.length } });
});

// GET /users/:id/checklist — onboarding checklist status
userRoutes.get("/:id/checklist", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  if (!canAccessUserScopedResource(user, userId)) return c.json({ error: "Forbidden" }, 403);
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) return c.json({ error: "Employé non trouvé" }, 404);
  const { computeWorkerChecklist } = await import("../services/onboarding-checklist.js");
  try {
    const checklist = sanitizeChecklistForViewer(computeWorkerChecklist(userId, restaurant.restaurantId), user, userId);
    return c.json({ data: checklist });
  } catch (e: any) {
    return c.json({ error: e?.message || "checklist failed" }, 500);
  }
});

// GET /users/:id/documents
userRoutes.get("/:id/documents", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  // Workers can only see their own documents
  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const docs = db
    .select({
      id: documents.id,
      name: documents.name,
      type: documents.type,
      filename: documents.filename,
      mimeType: documents.mimeType,
      size: documents.size,
      requirementKey: documents.requirementKey,
      issuedAt: documents.issuedAt,
      expiresAt: documents.expiresAt,
      signedAt: documents.signedAt,
      reviewedAt: documents.reviewedAt,
      reviewedBy: documents.reviewedBy,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .all();

  return c.json({ data: docs.filter((doc) => canAccessDocumentType(user, userId, doc.type)) });
});

// POST /users/:id/documents/presign — get a one-shot upload URL for OVH Object Storage.
// Browsers PUT the file body directly to OVH, then call POST /documents with the storageKey.
userRoutes.post("/:id/documents/presign", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const { filename, mimeType, size } = body as { filename?: string; mimeType?: string; size?: number };
  if (!filename || !mimeType || typeof size !== "number") {
    return c.json({ error: "filename, mimeType, size requis" }, 400);
  }

  const documentId = crypto.randomUUID();
  try {
    const presigned = await presignDocumentUpload({
      restaurantId: restaurant.restaurantId,
      userId,
      documentId,
      filename,
      mimeType,
      size,
    });
    return c.json({ data: { documentId, ...presigned } });
  } catch (err) {
    if (err instanceof StorageInactiveError) return c.json({ error: "Object storage indisponible" }, 503);
    if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
    throw err;
  }
});

// POST /users/:id/documents — upload document. Caller must first PUT the file
// to OVH via a presigned URL (POST /users/:id/documents/presign), then post the
// returned storageKey here. Base64 ingestion was removed in Phase E.
userRoutes.post("/:id/documents", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  // Only team editors or the user themselves can upload
  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const body = await c.req.json();
  const { name, type, filename, mimeType, size, storageKey, requirementKey, issuedAt, expiresAt, signedAt } = body;

  if (!name || !type || !filename || !mimeType) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  if (!canAccessDocumentType(user, userId, type)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!storageKey) {
    return c.json({ error: "storageKey requis" }, 400);
  }

  let storedSize = typeof size === "number" ? size : 0;
  let storageProvider: "ovh" | null = null;
  let confirmedStorageKey: string | null = null;

  try {
    const committed = await commitUploadedObject({
      pendingKey: storageKey,
      restaurantId: restaurant.restaurantId,
      userId,
      filename,
      expectedMimeType: mimeType,
    });
    storedSize = committed.size;
    storageProvider = "ovh";
    confirmedStorageKey = committed.storageKey;
  } catch (err) {
    if (err instanceof StorageInactiveError) return c.json({ error: "Object storage indisponible" }, 503);
    if (err instanceof InvalidUploadError) return c.json({ error: err.message }, err.status as 400 | 403 | 413);
    throw err;
  }

  const validDateOrNull = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

  const [doc] = db
    .insert(documents)
    .values({
      userId,
      restaurantId: restaurant.restaurantId,
      name,
      type,
      filename,
      mimeType,
      size: storedSize,
      data: "",
      storageProvider,
      storageKey: confirmedStorageKey,
      storageStatus: "ready",
      uploadedBy: user.id,
      requirementKey: typeof requirementKey === "string" && requirementKey.length > 0 ? requirementKey : null,
      issuedAt: validDateOrNull(issuedAt),
      expiresAt: validDateOrNull(expiresAt),
      signedAt: validDateOrNull(signedAt),
      // Admin/manager uploads are pre-confirmed — only the worker's magic-link
      // uploads (via /public/onboarding) need a separate review step.
      reviewedAt: can(user, "TEAM_EDIT") ? new Date().toISOString() : null,
      reviewedBy: can(user, "TEAM_EDIT") ? user.id : null,
    })
    .returning({
      id: documents.id,
      name: documents.name,
      type: documents.type,
      filename: documents.filename,
      signedAt: documents.signedAt,
      createdAt: documents.createdAt,
    })
    .all();

  return c.json({ data: doc }, 201);
});

// GET /users/:id/documents/:docId — download document
userRoutes.get("/:id/documents/:docId", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  const docId = c.req.param("docId");

  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [doc] = db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .limit(1)
    .all();

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }
  if (!canAccessDocumentType(user, userId, doc.type)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (doc.storageProvider === "ovh" && doc.storageKey) {
    const presigned = await presignDocumentDownload(doc.storageKey);
    const { data: _legacy, ...meta } = doc;
    return c.json({ data: { ...meta, url: presigned.url, urlExpiresAt: presigned.expiresAt } });
  }

  return c.json({ data: doc });
});

// PATCH /users/:id/documents/:docId — mark an existing document as signed (admin only)
// Used when the admin signs a contract in person — they just toggle the draft to "signed"
// instead of re-uploading a scan. Can also clear the signedAt back to null.
userRoutes.patch("/:id/documents/:docId", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "TEAM_EDIT")) return c.json({ error: "Forbidden" }, 403);
  const userId = c.req.param("id");
  const docId = c.req.param("docId");
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) return c.json({ error: "Employé non trouvé" }, 404);

  const [doc] = db.select({ type: documents.type })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!doc) return c.json({ error: "Document not found" }, 404);
  if (!canAccessDocumentType(user, userId, doc.type)) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, string | null> = {};
  if (body.signedAt === null) updates.signedAt = null;
  else if (typeof body.signedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.signedAt)) updates.signedAt = body.signedAt;
  if (Object.keys(updates).length === 0) return c.json({ error: "No valid fields to update" }, 400);

  db.update(documents).set(updates).where(and(
    eq(documents.id, docId),
    eq(documents.userId, userId),
    eq(documents.restaurantId, restaurant.restaurantId),
  )).run();
  return c.json({ data: { id: docId, ...updates } });
});

// POST /users/:id/documents/:docId/confirm — admin/manager confirms a worker
// upload so it counts toward the dossier checklist. Idempotent: confirming
// an already-confirmed doc is a no-op (returns existing review metadata).
userRoutes.post("/:id/documents/:docId/confirm", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  if (!can(user, "TEAM_EDIT")) return c.json({ error: "Forbidden" }, 403);
  const userId = c.req.param("id");
  const docId = c.req.param("docId");
  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) return c.json({ error: "Employé non trouvé" }, 404);

  const [doc] = db.select({ id: documents.id, type: documents.type, reviewedAt: documents.reviewedAt, reviewedBy: documents.reviewedBy })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!doc) return c.json({ error: "Document not found" }, 404);
  if (!canAccessDocumentType(user, userId, doc.type)) return c.json({ error: "Forbidden" }, 403);
  if (doc.reviewedAt) return c.json({ data: { id: doc.id, reviewedAt: doc.reviewedAt, reviewedBy: doc.reviewedBy } });

  const reviewedAt = new Date().toISOString();
  db.update(documents).set({ reviewedAt, reviewedBy: user.id })
    .where(and(eq(documents.id, docId), eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .run();
  return c.json({ data: { id: docId, reviewedAt, reviewedBy: user.id } });
});

// DELETE /users/:id/documents/:docId
userRoutes.delete("/:id/documents/:docId", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  const docId = c.req.param("docId");

  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [targetDoc] = db.select({ type: documents.type })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .limit(1).all();
  if (!targetDoc) return c.json({ error: "Document not found" }, 404);
  if (!canAccessDocumentType(user, userId, targetDoc.type)) return c.json({ error: "Forbidden" }, 403);

  const deleted = db
    .delete(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId), eq(documents.restaurantId, restaurant.restaurantId)))
    .returning({ id: documents.id, storageProvider: documents.storageProvider, storageKey: documents.storageKey })
    .all();

  if (deleted.length === 0) {
    return c.json({ error: "Document not found" }, 404);
  }

  const removed = deleted[0];
  if (removed.storageProvider === "ovh" && removed.storageKey) {
    deleteStoredObject(removed.storageKey).catch(() => {});
  }

  return c.json({ data: { deleted: true } });
});

// DELETE /users/:id — deactivate worker (soft delete)
// Keeps all historical data for payroll. Cancels future services, kills sessions.
userRoutes.delete("/:id", requireAdmin, async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  if (id === user.id) {
    return c.json({ error: "Impossible de désactiver votre propre compte" }, 400);
  }

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [target] = db
    .select({ id: users.id, role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();

  if (!target) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  if (target.role === "admin") {
    return c.json({ error: "Impossible de désactiver un propriétaire" }, 400);
  }

  if (!target.active) {
    return c.json({ error: "Cet employé est déjà désactivé" }, 400);
  }

  const today = new Date().toISOString().split("T")[0];

  db.transaction((tx) => {
    // Deactivate the user
    tx.update(users)
      .set({ active: false })
      .where(eq(users.id, id))
      .run();

    // Cancel future scheduled services (keep past for payroll)
    tx.update(services)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(and(
        eq(services.workerId, id),
        eq(services.restaurantId, restaurant.restaurantId),
        gte(services.date, today),
        eq(services.status, "scheduled"),
      ))
      .run();

    // Expire open replacement requests involving this worker
    tx.update(replacementRequests)
      .set({ status: "expired" })
      .where(and(
        or(
          eq(replacementRequests.status, "awaiting_admin_decision"),
          eq(replacementRequests.status, "awaiting_worker_reply"),
        )!,
        or(eq(replacementRequests.requesterId, id), eq(replacementRequests.targetId, id))!,
      ))
      .run();

    // Kill all active sessions
    tx.delete(sessions)
      .where(eq(sessions.userId, id))
      .run();
  });

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { deactivated: true } });
});

// POST /users/:id/reactivate — re-enable a deactivated worker (admin only)
userRoutes.post("/:id/reactivate", requireAdmin, async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [target] = db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();

  if (!target) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  if (target.active) {
    return c.json({ error: "Cet employé est déjà actif" }, 400);
  }

  db.update(users)
    .set({ active: true, inactiveFrom: null, inactiveUntil: null })
    .where(eq(users.id, id))
    .run();

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { reactivated: true } });
});

// POST /users/:id/temp-deactivate — temporarily deactivate a worker for a date range
userRoutes.post("/:id/temp-deactivate", requireAdmin, async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const { from, until } = await c.req.json<{ from: string; until: string }>();

  if (!from || !until || from > until) {
    return c.json({ error: "Dates invalides" }, 400);
  }

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [target] = db
    .select({ id: users.id, role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();

  if (!target) return c.json({ error: "Employé non trouvé" }, 404);
  if (target.role === "admin") return c.json({ error: "Impossible de désactiver un propriétaire" }, 400);

  db.update(users)
    .set({ inactiveFrom: from, inactiveUntil: until })
    .where(eq(users.id, id))
    .run();

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { tempDeactivated: true, from, until } });
});

// POST /users/:id/cancel-temp-deactivation — remove temporary deactivation
userRoutes.post("/:id/cancel-temp-deactivation", requireAdmin, async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [target] = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();

  if (!target) return c.json({ error: "Employé non trouvé" }, 404);

  db.update(users)
    .set({ inactiveFrom: null, inactiveUntil: null })
    .where(eq(users.id, id))
    .run();

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: { cancelled: true } });
});

// PUT /users/:id/permissions — admin overrides a manager's effective permissions.
// Body: { [Permission]: boolean | null } where null clears the override (back to role default).
// Only meaningful for managers; admins/workers ignore this column.
userRoutes.put("/:id/permissions", requireAdmin, async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  if (!verifyUserMembershipInRestaurant(id, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const [target] = db
    .select({ id: users.id, role: users.role, permissions: users.permissions })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();

  if (!target) return c.json({ error: "Employé non trouvé" }, 404);

  const parsed = parseManagerPermissionOverrides(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  db.update(users).set({ permissions: parsed.permissions }).where(eq(users.id, id)).run();

  return c.json({ data: { id, permissions: parsed.permissions } });
});

// ── Worker Availability ──

// GET /users/:id/availability
userRoutes.get("/:id/availability", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const rows = db
    .select({
      dayOfWeek: workerAvailability.dayOfWeek,
      midi: workerAvailability.midi,
      soir: workerAvailability.soir,
      midiStart: workerAvailability.midiStart,
      midiEnd: workerAvailability.midiEnd,
      soirStart: workerAvailability.soirStart,
      soirEnd: workerAvailability.soirEnd,
      continuous: workerAvailability.continuous,
      zones: workerAvailability.zones,
    })
    .from(workerAvailability)
    .where(and(eq(workerAvailability.workerId, userId), eq(workerAvailability.restaurantId, restaurant.restaurantId)))
    .all();

  // Parse zones JSON and return
  const data = rows.map(r => ({ ...r, zones: JSON.parse(r.zones || "{}") }));
  return c.json({ data });
});

// PUT /users/:id/availability — replace all 7 days (admin only)
userRoutes.put("/:id/availability", requirePermission("TEAM_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  const body = await c.req.json();
  const parsed = upsertAvailabilitySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  // Delete existing rows for this worker
  db.delete(workerAvailability)
    .where(and(eq(workerAvailability.workerId, userId), eq(workerAvailability.restaurantId, restaurant.restaurantId)))
    .run();

  // Insert new rows
  const rows = parsed.data.map((d: any) => ({
    workerId: userId,
    restaurantId: restaurant.restaurantId,
    dayOfWeek: d.dayOfWeek,
    midi: d.midi,
    soir: d.soir,
    midiStart: d.midiStart || null,
    midiEnd: d.midiEnd || null,
    soirStart: d.soirStart || null,
    soirEnd: d.soirEnd || null,
    continuous: d.continuous || false,
    zones: JSON.stringify(d.zones || {}),
  }));

  if (rows.length > 0) {
    db.insert(workerAvailability).values(rows).run();
  }

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: parsed.data });
});

// ── Worker Restrictions (time-slot based unavailability) ──

// GET /users/:id/restrictions
userRoutes.get("/:id/restrictions", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const rows = db
    .select({
      dayOfWeek: workerRestrictions.dayOfWeek,
      startTime: workerRestrictions.startTime,
      endTime: workerRestrictions.endTime,
      reason: workerRestrictions.reason,
      effectiveFrom: workerRestrictions.effectiveFrom,
      effectiveUntil: workerRestrictions.effectiveUntil,
    })
    .from(workerRestrictions)
    .where(and(eq(workerRestrictions.workerId, userId), eq(workerRestrictions.restaurantId, restaurant.restaurantId)))
    .all();

  return c.json({ data: rows });
});

// PUT /users/:id/restrictions — replace all restrictions (admin only)
userRoutes.put("/:id/restrictions", requirePermission("TEAM_EDIT"), async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");
  const body = await c.req.json();
  const parsed = upsertRestrictionsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation error", details: flattenZodError(parsed.error) }, 400);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  // Delete existing restrictions
  db.delete(workerRestrictions)
    .where(and(eq(workerRestrictions.workerId, userId), eq(workerRestrictions.restaurantId, restaurant.restaurantId)))
    .run();

  // Insert new restrictions
  const rows = parsed.data.map((d) => ({
    workerId: userId,
    restaurantId: restaurant.restaurantId,
    dayOfWeek: d.dayOfWeek,
    startTime: d.startTime || null,
    endTime: d.endTime || null,
    reason: d.reason || null,
  }));

  if (rows.length > 0) {
    db.insert(workerRestrictions).values(rows).run();
  }

  bumpCacheVersion(restaurant.restaurantId);
  return c.json({ data: parsed.data });
});

// ── Worker Preferred Schedule (worker-managed) ──

// GET /users/:id/preferred-schedule
userRoutes.get("/:id/preferred-schedule", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const rows = db
    .select({
      dayOfWeek: workerPreferredSchedule.dayOfWeek,
      midi: workerPreferredSchedule.midi,
      soir: workerPreferredSchedule.soir,
    })
    .from(workerPreferredSchedule)
    .where(and(eq(workerPreferredSchedule.workerId, userId), eq(workerPreferredSchedule.restaurantId, restaurant.restaurantId)))
    .all();

  return c.json({ data: rows });
});

// PUT /users/:id/preferred-schedule — worker sets their own preferences
userRoutes.put("/:id/preferred-schedule", async (c) => {
  const user = c.get("user");
  const restaurant = requestRestaurant(c);
  const userId = c.req.param("id");

  // Workers can only update their own; team editors can update any
  if (!canAccessUserScopedResource(user, userId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!verifyUserInRestaurant(userId, restaurant.restaurantId)) {
    return c.json({ error: "Employé non trouvé" }, 404);
  }

  const body = await c.req.json();
  if (!Array.isArray(body)) return c.json({ error: "Expected array" }, 400);

  // Delete existing
  db.delete(workerPreferredSchedule)
    .where(and(eq(workerPreferredSchedule.workerId, userId), eq(workerPreferredSchedule.restaurantId, restaurant.restaurantId)))
    .run();

  // Insert new
  const rows = body
    .filter((d: any) => d.dayOfWeek >= 1 && d.dayOfWeek <= 7)
    .map((d: any) => ({
      workerId: userId,
      restaurantId: restaurant.restaurantId,
      dayOfWeek: d.dayOfWeek,
      midi: !!d.midi,
      soir: !!d.soir,
      zones: JSON.stringify(d.zones || {}),
    }));

  if (rows.length > 0) {
    db.insert(workerPreferredSchedule).values(rows).run();
  }
  bumpCacheVersion(restaurant.restaurantId);

  return c.json({ data: body });
});
