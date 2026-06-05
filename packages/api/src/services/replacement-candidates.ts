import { and, eq, gte, isNotNull, isNull, lte, ne, or, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db/connection.js";
import type { AppDatabase } from "../db/connection.js";
import {
  users,
  services,
  holidayRequests,
  workerAvailability,
  workerRestrictions,
  workerPreferredSchedule,
  restaurants,
  ownerMemberships,
  restaurantMemberships,
  workerRestaurantProfiles,
  workerShareAuthorizations,
} from "../db/schema.js";
import {
  buildRestrictionMap,
  isAvailableByRestrictions,
  serviceHours,
} from "../utils/scheduling.js";
import { columnExists } from "./restaurant-context.js";

export interface CandidateScore {
  workerId: string;
  name: string;
  score: number;
  reasons: string[];
}

export interface RankInput {
  restaurantId: string;
  date: string;
  startTime: string;
  endTime: string;
  role: "kitchen" | "floor";
  /** sub-roles required by the slot (e.g. ["Chef","Cuisinier"]); empty = any */
  requiredSubRoles?: string[];
  /** workers to exclude (typically the requester) */
  excludeWorkerIds?: string[];
  /** override DB instance (tests) */
  db?: AppDatabase;
}

const dayOfWeek = (date: string): number => {
  const d = new Date(date + "T12:00:00").getDay();
  return d === 0 ? 7 : d;
};

const weekStart = (date: string): string => {
  const d = new Date(date + "T12:00:00");
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
};

const offsetDate = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const minutesFromBase = (serviceDate: string, baseDate: string, time: string): number => {
  const days = Math.round((new Date(`${serviceDate}T12:00:00`).getTime() - new Date(`${baseDate}T12:00:00`).getTime()) / 86_400_000);
  const [h, m] = time.split(":").map(Number);
  return days * 1440 + h * 60 + m;
};

const datedTimesOverlap = (aDate: string, aStart: string, aEnd: string, bDate: string, bStart: string, bEnd: string): boolean => {
  const as = minutesFromBase(aDate, bDate, aStart);
  let ae = minutesFromBase(aDate, bDate, aEnd);
  const bs = minutesFromBase(bDate, bDate, bStart);
  let be = minutesFromBase(bDate, bDate, bEnd);
  if (ae <= as) ae += 1440;
  if (be <= bs) be += 1440;
  return as < be && bs < ae;
};

const parseSubRoles = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Rank workers who could pick up an unwanted service.
 * Returns top 5 sorted by score desc. Pure read — no DB writes.
 */
export function rankReplacementCandidates(input: RankInput): CandidateScore[] {
  const { restaurantId, date, startTime, endTime, role } = input;
  const db = input.db ?? defaultDb;
  const excludeIds = new Set(input.excludeWorkerIds ?? []);
  const dow = dayOfWeek(date);
  const wkStart = weekStart(date);
  const required = input.requiredSubRoles ?? [];

  const restaurant = db.select().from(restaurants).where(eq(restaurants.id, restaurantId)).get();
  const otCap = restaurant?.overtimeWeeklyCap ?? 48;
  let ownerRestaurantIds = [restaurantId];
  if (restaurant?.ownerId) {
    try {
      ownerRestaurantIds = db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.ownerId, restaurant.ownerId))
      .all()
      .map((r) => r.id);
    } catch {
      ownerRestaurantIds = [restaurantId];
    }
  }
  const useMembershipScope = input.db
    ? true
    : columnExists("restaurant_memberships", "restaurant_id") && columnExists("restaurants", "owner_id");

  const localRoleWorkers = (useMembershipScope
    ? db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        passwordHash: users.passwordHash,
        role: users.role,
        restaurantId: restaurantMemberships.restaurantId,
        priority: users.priority,
        address: users.address,
        addressStreet: users.addressStreet,
        addressPostalCode: users.addressPostalCode,
        addressCity: users.addressCity,
        iban: users.iban,
        startDate: users.startDate,
        emergencyContact: users.emergencyContact,
        emergencyPhone: users.emergencyPhone,
        dateOfBirth: users.dateOfBirth,
        birthPlace: users.birthPlace,
        nationality: users.nationality,
        nir: users.nir,
        notes: users.notes,
        managerNotes: users.managerNotes,
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
        rateEffectiveFrom: users.rateEffectiveFrom,
        permissions: users.permissions,
        mustChangePassword: users.mustChangePassword,
        userNoticeVersion: users.userNoticeVersion,
        userNoticeAcceptedAt: users.userNoticeAcceptedAt,
        userNoticeIpAddress: users.userNoticeIpAddress,
        userNoticeUserAgent: users.userNoticeUserAgent,
        whatsappOptIn: users.whatsappOptIn,
        whatsappOptInAt: users.whatsappOptInAt,
        whatsappOptOutAt: users.whatsappOptOutAt,
        lastDossierReminderAt: users.lastDossierReminderAt,
        createdAt: users.createdAt,
      })
      .from(restaurantMemberships)
      .innerJoin(users, eq(restaurantMemberships.userId, users.id))
      .where(
        and(
          eq(restaurantMemberships.restaurantId, restaurantId),
          eq(restaurantMemberships.role, role),
          eq(restaurantMemberships.active, true),
          eq(users.active, true),
        ),
      )
      .all()
      .map((w) => ({ ...w, sharedFromRestaurantId: null as string | null }))
    : db
      .select()
      .from(users)
      .where(
        and(
          eq(users.restaurantId, restaurantId),
          eq(users.role, role),
          eq(users.active, true),
        ),
      )
      .all()
      .map((w) => ({ ...w, sharedFromRestaurantId: null as string | null }))
    )
    .filter((w) => !excludeIds.has(w.id));

  const localWorkerIds = new Set(localRoleWorkers.map((w) => w.id));
  const targetMemberIds = useMembershipScope
    ? new Set(db
      .select({ userId: restaurantMemberships.userId })
      .from(restaurantMemberships)
      .where(and(
        eq(restaurantMemberships.restaurantId, restaurantId),
        eq(restaurantMemberships.active, true),
      ))
      .all()
      .map((row) => row.userId))
    : localWorkerIds;
  const sharedRoleWorkers = useMembershipScope && restaurant?.ownerId
    ? db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        passwordHash: users.passwordHash,
        role: users.role,
        restaurantId: workerShareAuthorizations.targetRestaurantId,
        priority: workerRestaurantProfiles.priority,
        address: users.address,
        addressStreet: users.addressStreet,
        addressPostalCode: users.addressPostalCode,
        addressCity: users.addressCity,
        iban: users.iban,
        startDate: users.startDate,
        emergencyContact: users.emergencyContact,
        emergencyPhone: users.emergencyPhone,
        dateOfBirth: users.dateOfBirth,
        birthPlace: users.birthPlace,
        nationality: users.nationality,
        nir: users.nir,
        notes: users.notes,
        managerNotes: workerRestaurantProfiles.managerNotes,
        subRole: users.subRole,
        subRoles: workerRestaurantProfiles.subRoles,
        overtimeWilling: users.overtimeWilling,
        coupureWilling: users.coupureWilling,
        multiRestaurantWilling: users.multiRestaurantWilling,
        matricule: workerRestaurantProfiles.matricule,
        contractType: workerRestaurantProfiles.contractType,
        contractEndDate: workerRestaurantProfiles.contractEndDate,
        contractHours: workerRestaurantProfiles.contractHours,
        maxWeeklyHours: workerRestaurantProfiles.maxWeeklyHours,
        adminOtOverride: workerRestaurantProfiles.adminOtOverride,
        active: users.active,
        inactiveFrom: users.inactiveFrom,
        inactiveUntil: users.inactiveUntil,
        hcrLevel: workerRestaurantProfiles.hcrLevel,
        hourlyRate: workerRestaurantProfiles.hourlyRate,
        rateEffectiveFrom: users.rateEffectiveFrom,
        permissions: users.permissions,
        mustChangePassword: users.mustChangePassword,
        userNoticeVersion: users.userNoticeVersion,
        userNoticeAcceptedAt: users.userNoticeAcceptedAt,
        userNoticeIpAddress: users.userNoticeIpAddress,
        userNoticeUserAgent: users.userNoticeUserAgent,
        whatsappOptIn: users.whatsappOptIn,
        whatsappOptInAt: users.whatsappOptInAt,
        whatsappOptOutAt: users.whatsappOptOutAt,
        lastDossierReminderAt: users.lastDossierReminderAt,
        createdAt: users.createdAt,
        sharedFromRestaurantId: workerShareAuthorizations.sourceRestaurantId,
      })
      .from(workerShareAuthorizations)
      .innerJoin(users, eq(workerShareAuthorizations.userId, users.id))
      .innerJoin(ownerMemberships, and(
        eq(ownerMemberships.ownerId, workerShareAuthorizations.ownerId),
        eq(ownerMemberships.userId, workerShareAuthorizations.userId),
      ))
      .innerJoin(workerRestaurantProfiles, and(
        eq(workerRestaurantProfiles.restaurantId, workerShareAuthorizations.targetRestaurantId),
        eq(workerRestaurantProfiles.userId, workerShareAuthorizations.userId),
      ))
      .innerJoin(restaurantMemberships, and(
        eq(restaurantMemberships.restaurantId, workerShareAuthorizations.sourceRestaurantId),
        eq(restaurantMemberships.userId, workerShareAuthorizations.userId),
        eq(restaurantMemberships.role, workerShareAuthorizations.role),
        eq(restaurantMemberships.active, true),
      ))
      .where(
        and(
          eq(workerShareAuthorizations.ownerId, restaurant.ownerId),
          eq(workerShareAuthorizations.targetRestaurantId, restaurantId),
          eq(workerShareAuthorizations.role, role),
          eq(workerShareAuthorizations.status, "accepted"),
          isNotNull(workerShareAuthorizations.workerConsentedAt),
          isNull(workerShareAuthorizations.revokedAt),
          eq(users.active, true),
          eq(workerRestaurantProfiles.multiRestaurantWilling, true),
        ),
      )
      .all()
      .filter((w) => !excludeIds.has(w.id) && !targetMemberIds.has(w.id) && ownerRestaurantIds.includes(w.sharedFromRestaurantId))
    : [];

  const sameRoleWorkers = [...localRoleWorkers, ...sharedRoleWorkers];

  if (sameRoleWorkers.length === 0) return [];

  // Filter: not on approved/pending holiday that day
  const onHoliday = new Set(
    db
      .select({ workerId: holidayRequests.workerId })
      .from(holidayRequests)
      .where(
        and(
          useMembershipScope && ownerRestaurantIds.length > 0
            ? inArray(holidayRequests.restaurantId, ownerRestaurantIds)
            : eq(holidayRequests.restaurantId, restaurantId),
          or(eq(holidayRequests.status, "approved"), eq(holidayRequests.status, "pending"))!,
          lte(holidayRequests.startDate, date),
          gte(holidayRequests.endDate, date),
        ),
      )
      .all()
      .map((r) => r.workerId),
  );

  // Filter: not already scheduled on overlapping service that day
  const dayServices = db
    .select({
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
    })
    .from(services)
    .where(
      and(
        useMembershipScope && ownerRestaurantIds.length > 0
          ? inArray(services.restaurantId, ownerRestaurantIds)
          : eq(services.restaurantId, restaurantId),
        inArray(services.date, [offsetDate(date, -1), date, offsetDate(date, 1)]),
        ne(services.status, "cancelled"),
      ),
    )
    .all();

  const overlapping = new Set(
    dayServices
      .filter((s) => datedTimesOverlap(s.date, s.startTime, s.endTime, date, startTime, endTime))
      .map((s) => s.workerId),
  );

  // Build restriction map for restaurant
  const restrictionRows = db
    .select({
      workerId: workerRestrictions.workerId,
      dayOfWeek: workerRestrictions.dayOfWeek,
      startTime: workerRestrictions.startTime,
      endTime: workerRestrictions.endTime,
      effectiveFrom: workerRestrictions.effectiveFrom,
      effectiveUntil: workerRestrictions.effectiveUntil,
    })
    .from(workerRestrictions)
    .where(eq(workerRestrictions.restaurantId, restaurantId))
    .all();
  const restrictionMap = buildRestrictionMap(restrictionRows);

  // Availability rows (for "no row = available" fallback)
  const availRows = db
    .select()
    .from(workerAvailability)
    .where(eq(workerAvailability.restaurantId, restaurantId))
    .all();
  const workersWithAvail = new Set(availRows.map((a) => a.workerId));
  const availForDay = new Map<string, { midi: boolean; soir: boolean }>();
  for (const a of availRows) {
    if (a.dayOfWeek === dow) availForDay.set(a.workerId, { midi: !!a.midi, soir: !!a.soir });
  }

  // Preferred-schedule rows for soft scoring (2-zone: midi < 14h, soir ≥ 14h)
  const prefRows = db
    .select({
      workerId: workerPreferredSchedule.workerId,
      dayOfWeek: workerPreferredSchedule.dayOfWeek,
      midi: workerPreferredSchedule.midi,
      soir: workerPreferredSchedule.soir,
    })
    .from(workerPreferredSchedule)
    .where(eq(workerPreferredSchedule.restaurantId, restaurantId))
    .all();
  const prefMap = new Map<string, Map<number, { midi: boolean; soir: boolean }>>();
  for (const p of prefRows) {
    if (!prefMap.has(p.workerId)) prefMap.set(p.workerId, new Map());
    prefMap.get(p.workerId)!.set(p.dayOfWeek, { midi: !!p.midi, soir: !!p.soir });
  }

  // Hours already worked this week per worker (for OT cap check)
  const weekServices = db
    .select({
      workerId: services.workerId,
      startTime: services.startTime,
      endTime: services.endTime,
    })
    .from(services)
    .where(
      and(
        useMembershipScope && ownerRestaurantIds.length > 0
          ? inArray(services.restaurantId, ownerRestaurantIds)
          : eq(services.restaurantId, restaurantId),
        gte(services.date, wkStart),
        lte(services.date, date),
        ne(services.status, "cancelled"),
      ),
    )
    .all();
  const hoursWorked = new Map<string, number>();
  for (const s of weekServices) {
    hoursWorked.set(s.workerId, (hoursWorked.get(s.workerId) ?? 0) + serviceHours(s.startTime, s.endTime));
  }

  const slotHours = serviceHours(startTime, endTime);
  const slotBucket: "midi" | "soir" = startTime < "14:00" ? "midi" : "soir";

  const candidates: CandidateScore[] = [];
  for (const w of sameRoleWorkers) {
    if (onHoliday.has(w.id)) continue;
    if (overlapping.has(w.id)) continue;

    // Contract end date (CDD/saisonnier expired)
    if (w.contractEndDate && w.contractEndDate < date) continue;

    // Availability: local workers keep the legacy "no row = available" fallback,
    // but shared workers need an explicit target-restaurant availability row.
    const a = availForDay.get(w.id);
    if (w.sharedFromRestaurantId && !a) continue;
    if (a || workersWithAvail.has(w.id)) {
      if (!a) continue;
      const wantsMidi = startTime < "16:00";
      if (wantsMidi && !a.midi) continue;
      if (!wantsMidi && !a.soir) continue;
    }

    // Time-slot restrictions
    if (!isAvailableByRestrictions(restrictionMap, w.id, dow, startTime, endTime, date)) continue;

    // OT cap (personal preference + admin override)
    const personalCap = Math.min(
      w.maxWeeklyHours ?? otCap,
      w.adminOtOverride ?? otCap,
    );
    const projected = (hoursWorked.get(w.id) ?? 0) + slotHours;
    if (projected > personalCap) continue;

    // ── Scoring ──
    let score = 0;
    const reasons: string[] = [];
    if (w.sharedFromRestaurantId) reasons.push("partagé");

    // Sub-role match
    const wSubRoles = parseSubRoles(w.subRoles);
    if (required.length > 0) {
      const exact = required.some((r) => wSubRoles.includes(r));
      if (exact) {
        score += 60;
        reasons.push("sous-rôle exact");
      } else {
        // No exact match — penalize but don't exclude (sous-chef fallback to chef)
        score += 10;
      }
    } else if (wSubRoles.length > 0) {
      score += 30;
    }

    // Priority (1=top, higher=lower)
    if (w.priority === 1) {
      score += 20;
      reasons.push("priorité haute");
    } else if (w.priority === 2) {
      score += 10;
    }

    // Contract deficit (under-utilized worker)
    if (w.contractHours) {
      const deficit = w.contractHours - (hoursWorked.get(w.id) ?? 0);
      if (deficit > 0) {
        score += Math.min(deficit, 15);
        if (deficit >= 5) reasons.push(`-${Math.round(deficit)}h sur contrat`);
      }
    }

    // Coupure preference if shift looks like a coupure leg
    const isCoupureLeg = dayServices.some(
      (s) => s.workerId !== w.id && (s.startTime === endTime || s.endTime === startTime),
    );
    if (isCoupureLeg && w.coupureWilling) {
      score += 10;
      reasons.push("ok coupure");
    }

    // Time-of-day preference (2-zone: midi < 14h, soir ≥ 14h)
    const dayPrefs = prefMap.get(w.id)?.get(dow);
    if (dayPrefs && dayPrefs[slotBucket]) {
      score += 5;
      reasons.push("créneau préféré");
    }

    // OT-willing bump if we're pushing them into OT (small)
    const wouldOT = projected > (w.contractHours ?? 35);
    if (wouldOT) {
      if (w.overtimeWilling) {
        score += 5;
      } else {
        score -= 15;
        reasons.push("dépasse contrat");
      }
    }

    candidates.push({ workerId: w.id, name: w.name, score, reasons });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}
