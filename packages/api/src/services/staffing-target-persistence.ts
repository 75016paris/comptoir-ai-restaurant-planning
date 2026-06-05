import { and, eq, sql } from "drizzle-orm";
import { serviceTemplateOverrides, serviceTemplates, staffingProfiles, staffingSchedule, staffingTargets } from "../db/schema.js";

type Tx = any;

type StaffingProfileInput = {
  id?: string;
  name?: string;
  sortOrder?: number;
  dayPriorities?: unknown;
  preferredAssignments?: unknown;
};

type StaffingTargetInput = {
  profileId?: string | null;
  dayOfWeek?: number;
  role?: "kitchen" | "floor" | string;
  zone?: string;
  count?: number;
  roleBreakdown?: unknown;
};

type ProfileTemplateInput = {
  profileId?: string | null;
  role?: "kitchen" | "floor" | string;
  zone?: string;
  startTime?: string;
  endTime?: string;
  sortOrder?: number;
  overrides?: Array<{ dayOfWeek?: number; startTime?: string; endTime?: string }>;
};

export function resolvePreferredAssignmentsForSave(
  profile: { id?: string; preferredAssignments?: unknown },
  priorAssignments: Map<string, string>,
): string {
  if (profile.preferredAssignments != null) {
    return typeof profile.preferredAssignments === "string"
      ? profile.preferredAssignments
      : JSON.stringify(profile.preferredAssignments);
  }
  return profile.id && priorAssignments.has(profile.id) ? priorAssignments.get(profile.id)! : "[]";
}

export function loadPreferredAssignmentsByProfile(tx: Tx, restaurantId: string): Map<string, string> {
  const priorAssignments = new Map<string, string>();
  for (const r of tx.select({ id: staffingProfiles.id, preferredAssignments: staffingProfiles.preferredAssignments })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, restaurantId))
    .all()) {
    priorAssignments.set(r.id, r.preferredAssignments);
  }
  return priorAssignments;
}

function jsonOrString(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function loadProfileTemplatesByRestaurant(tx: Tx, restaurantId: string, keepProfileIds: Set<string>): ProfileTemplateInput[] {
  const raw = tx.select({
    id: serviceTemplates.id,
    profileId: serviceTemplates.profileId,
    role: serviceTemplates.role,
    zone: serviceTemplates.zone,
    startTime: serviceTemplates.startTime,
    endTime: serviceTemplates.endTime,
    sortOrder: serviceTemplates.sortOrder,
  }).from(serviceTemplates)
    .where(and(
      eq(serviceTemplates.restaurantId, restaurantId),
      sql`${serviceTemplates.profileId} IS NOT NULL`,
    ))
    .all()
    .filter((t: { profileId: string | null }) => t.profileId && keepProfileIds.has(t.profileId));

  const ids = raw.map((t: { id: string }) => t.id);
  const overrides = ids.length > 0
    ? tx.select({
        templateId: serviceTemplateOverrides.templateId,
        dayOfWeek: serviceTemplateOverrides.dayOfWeek,
        startTime: serviceTemplateOverrides.startTime,
        endTime: serviceTemplateOverrides.endTime,
      }).from(serviceTemplateOverrides)
        .where(sql`${serviceTemplateOverrides.templateId} IN (${sql.join(ids.map((id: string) => sql`${id}`), sql`, `)})`)
        .all()
    : [];

  return raw.map((t: { id: string; profileId: string | null; role: string; zone: string; startTime: string; endTime: string; sortOrder: number }) => ({
    profileId: t.profileId,
    role: t.role,
    zone: t.zone,
    startTime: t.startTime,
    endTime: t.endTime,
    sortOrder: t.sortOrder,
    overrides: overrides
      .filter((o: { templateId: string }) => o.templateId === t.id)
      .map((o: { dayOfWeek: number; startTime: string; endTime: string }) => ({
        dayOfWeek: o.dayOfWeek,
        startTime: o.startTime,
        endTime: o.endTime,
      })),
  }));
}

function deleteProfileTemplates(tx: Tx, restaurantId: string) {
  const perProfileIds = tx.select({ id: serviceTemplates.id }).from(serviceTemplates)
    .where(and(
      eq(serviceTemplates.restaurantId, restaurantId),
      sql`${serviceTemplates.profileId} IS NOT NULL`,
    )).all().map((r: { id: string }) => r.id);

  if (perProfileIds.length > 0) {
    tx.delete(serviceTemplateOverrides)
      .where(sql`${serviceTemplateOverrides.templateId} IN (${sql.join(perProfileIds.map((id: string) => sql`${id}`), sql`, `)})`)
      .run();
  }

  tx.delete(serviceTemplates).where(and(
    eq(serviceTemplates.restaurantId, restaurantId),
    sql`${serviceTemplates.profileId} IS NOT NULL`,
  )).run();
}

export function replaceStaffingTargetsConfiguration(tx: Tx, input: {
  restaurantId: string;
  profiles: StaffingProfileInput[];
  targets: StaffingTargetInput[];
  profileTemplates?: ProfileTemplateInput[];
}) {
  const { restaurantId, profiles, targets, profileTemplates } = input;
  const priorAssignments = loadPreferredAssignmentsByProfile(tx, restaurantId);
  const nextProfileIds = new Set(profiles.map(p => p.id).filter((id): id is string => typeof id === "string" && id.length > 0));
  const templatesToSave = Array.isArray(profileTemplates)
    ? profileTemplates
    : loadProfileTemplatesByRestaurant(tx, restaurantId, nextProfileIds);

  tx.delete(staffingTargets).where(eq(staffingTargets.restaurantId, restaurantId)).run();
  deleteProfileTemplates(tx, restaurantId);
  tx.delete(staffingSchedule).where(eq(staffingSchedule.restaurantId, restaurantId)).run();
  tx.delete(staffingProfiles).where(eq(staffingProfiles.restaurantId, restaurantId)).run();

  for (const p of profiles) {
    const id = p.id || crypto.randomUUID();
    tx.insert(staffingProfiles).values({
      id,
      restaurantId,
      name: p.name?.trim() || "",
      sortOrder: p.sortOrder ?? 0,
      dayPriorities: jsonOrString(p.dayPriorities, "{}"),
      preferredAssignments: resolvePreferredAssignmentsForSave({ ...p, id }, priorAssignments),
    }).run();
  }

  for (const t of targets) {
    if (typeof t.dayOfWeek !== "number" || !t.role || !t.zone || typeof t.count !== "number") continue;
    if (t.count <= 0) continue;
    tx.insert(staffingTargets).values({
      restaurantId,
      profileId: t.profileId,
      dayOfWeek: t.dayOfWeek,
      role: t.role,
      zone: t.zone,
      count: t.count,
      roleBreakdown: jsonOrString(t.roleBreakdown, "{}"),
    }).run();
  }

  if (Array.isArray(templatesToSave)) {
    for (const t of templatesToSave) {
      if (!t.profileId || !t.role || !t.zone || !t.startTime || !t.endTime) continue;
      const [inserted] = tx.insert(serviceTemplates).values({
        restaurantId,
        profileId: t.profileId,
        role: t.role,
        zone: t.zone,
        startTime: t.startTime,
        endTime: t.endTime,
        sortOrder: t.sortOrder ?? 0,
      }).returning({ id: serviceTemplates.id }).all();

      if (Array.isArray(t.overrides)) {
        for (const o of t.overrides) {
          if (typeof o.dayOfWeek !== "number" || !o.startTime || !o.endTime) continue;
          tx.insert(serviceTemplateOverrides).values({
            templateId: inserted.id,
            dayOfWeek: o.dayOfWeek,
            startTime: o.startTime,
            endTime: o.endTime,
          }).run();
        }
      }
    }
  }
}
