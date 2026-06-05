/**
 * French labor law compliance checker — Convention Collective HCR
 * (Hôtels, Cafés, Restaurants)
 *
 * Checks weekly schedules against regulatory limits and returns violations.
 * Designed to be re-run whenever the schedule changes.
 */

import { db } from "../db/connection.js";
import { services, users, holidayRequests, restaurants, calendarEvents, publishedWeeks } from "../db/schema.js";
import { eq, and, gte, lte, ne, inArray } from "drizzle-orm";
import { calendarDaysBetween, hasChefLabel, parseServerTimestamp, todayInTimeZone } from "@comptoir/shared";
import { computeLeaveBalances } from "./holiday-advice.js";
import { listRestaurantMemberUserIds, listSchedulingRosterWorkers } from "./restaurant-context.js";

// ── Rule references ──

export const RULES = {
  MAX_DAILY_HOURS: {
    code: "HCR-L3121-18",
    label: "Durée maximale quotidienne",
    limit: 10,
    exceptionalLimit: 11,
    // Role-specific limits per HCR convention
    kitchenChefLimit: 11,   // chef de cuisine
    salleLimit: 11.5,       // serveur (11h30)
    description: "10h max par jour (11h chef de cuisine, 11h30 serveur)",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020517",
  },
  MAX_WEEKLY_HOURS: {
    code: "HCR-L3121-20",
    label: "Durée maximale hebdomadaire absolue",
    limit: 48,
    description: "48h max par semaine",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020513",
  },
  AVG_WEEKLY_HOURS_12W: {
    code: "HCR-L3121-22",
    label: "Durée maximale hebdomadaire moyenne",
    limit: 46, // HCR convention allows 46h avg over 12 weeks (vs 44h general)
    description: "46h max en moyenne sur 12 semaines (convention HCR)",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020509",
  },
  OVERTIME_THRESHOLD: {
    code: "HCR-L3121-27",
    label: "Seuil heures supplémentaires",
    limit: 39, // HCR convention: overtime starts at 39h (not 35h)
    description: "Heures sup au-delà de 39h/semaine (convention HCR)",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020109",
  },
  MIN_DAILY_REST: {
    code: "HCR-L3131-1",
    label: "Repos quotidien minimum",
    limit: 11,
    hcrDerogation: 10, // HCR can reduce to 10h with compensation
    description: "11h de repos minimum entre 2 journées (10h dérogation HCR)",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033019913",
  },
  MAX_CONSECUTIVE_DAYS: {
    code: "HCR-L3132-1",
    label: "Jours de travail consécutifs",
    limit: 6,
    description: "6 jours consécutifs maximum",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033019901",
  },
  WEEKLY_REST: {
    code: "HCR-L3132-2",
    label: "Repos hebdomadaire",
    limit: 2, // days off per week
    hcrMinimum: 1.5, // HCR allows 1.5 days (1 full + 1 half)
    description: "2 jours de repos par semaine (1,5 jour minimum HCR)",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033019899",
  },
  BREAK_6H: {
    code: "HCR-L3121-16",
    label: "Pause obligatoire",
    limit: 6,
    breakMinutes: 20,
    description: "20 min de pause après 6h de travail continu",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020521",
  },
  MAX_AMPLITUDE: {
    code: "HCR-L3121-34",
    label: "Amplitude horaire maximale",
    limit: 13,
    description: "13h max entre le début et la fin de la journée de travail (coupures incluses)",
    lawUrl: "", // CCN HCR convention, no single Code du travail article — derives from L3131-1 (repos quotidien)
  },
  MODIFICATION_NOTICE: {
    code: "HCR-L3121-47",
    label: "Délai de modification du planning",
    limit: 8,
    description: "Modification du planning au moins 8 jours à l'avance (le salarié peut refuser en-deçà)",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006902462",
  },
  ADVANCE_NOTICE: {
    code: "HCR-L3171-1",
    label: "Affichage du planning 15 jours à l'avance",
    limit: 15,
    description: "Le planning doit être communiqué au moins 15 jours avant le début de la période",
    lawUrl: "", // CCN HCR obligation — distinct from modification notice (L3121-47)
  },
  OVERTIME_POLICY: {
    code: "COMPTOIR-OT-01",
    label: "Politique heures supplémentaires",
    description: "Respect de la politique overtime définie dans les préférences (strict/controlled/flexible)",
    lawUrl: "",
  },
  PUBLIC_HOLIDAY_WORK: {
    code: "HCR-JOURS-FERIES",
    label: "Travail un jour férié",
    description: "Information : affectation un jour férié. Vérifier que la majoration / récupération est gérée en paie.",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006902604",
  },
  MAY_1_DOUBLE_PAY: {
    code: "HCR-1-MAI-DOUBLE",
    label: "1er Mai — rémunération double obligatoire",
    description: "Le 1er mai est le seul jour férié légalement chômé. Si travaillé, majoration 100% obligatoire (salaire × 2).",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006902609",
  },
  PAID_LEAVE_MINIMUM: {
    code: "HCR-CONGES-PAYES-MINIMUM",
    label: "Congés payés — 5 semaines légales à poser",
    description: "2,5 jours ouvrables acquis par mois, 30 jours (5 semaines) par an. Avertissement quand le solde non-pris approche de l'expiration le 31 mai.",
    lawUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033020952",
  },
} as const;

/** All rule codes for validation */
export const ALL_RULE_CODES = Object.values(RULES).map(r => r.code);

/** Rule metadata for the preferences UI */
export type ComplianceRuleMeta = {
  code: string;
  label: string;
  description: string;
  lawUrl: string;
};

export function getComplianceRulesMeta(): ComplianceRuleMeta[] {
  return Object.values(RULES).map(r => ({
    code: r.code,
    label: r.label,
    description: r.description,
    lawUrl: r.lawUrl,
  }));
}

export type Severity = "error" | "warning" | "info";

export type ComplianceViolation = {
  workerId: string;
  workerName: string;
  rule: string;
  code: string;
  severity: Severity;
  message: string;
  detail: string;
  date?: string; // specific date if applicable
  value?: number; // the actual value that triggered the violation
  limit?: number; // the limit that was exceeded
};

export type ComplianceResult = {
  week: { from: string; to: string };
  violations: ComplianceViolation[];
  overtime: OvertimeEntry[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    workersChecked: number;
  };
};

export type OvertimeEntry = {
  workerId: string;
  workerName: string;
  weeklyHours: number;
  overtimeHours: number;
  breakdown: {
    rate110: number; // hours at 110% (h40-h43)
    rate120: number; // hours at 120% (h44-h47)
    rate150: number; // hours at 150% (h48+)
  };
};

// ── Helpers ──

function serviceMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60; // overnight service
  return diff;
}

function serviceHours(startTime: string, endTime: string): number {
  return serviceMinutes(startTime, endTime) / 60;
}

/** Get ISO day-of-week (1=Mon..7=Sun) */
function isoDow(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00");
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** Get Monday of the week containing dateStr */
function getMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d.toISOString().split("T")[0];
}

/** Generate array of date strings for a Mon-Sun week */
function weekDates(mondayStr: string): string[] {
  const d = new Date(mondayStr + "T12:00:00");
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(d);
    cur.setDate(d.getDate() + i);
    dates.push(cur.toISOString().split("T")[0]);
  }
  return dates;
}

/** Convert HH:MM to minutes since midnight */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// ── Main compliance check ──

export function checkCompliance(
  restaurantId: string,
  dateStr: string,
): ComplianceResult {
  const mondayStr = getMonday(dateStr);
  const dates = weekDates(mondayStr);
  const week = { from: dates[0], to: dates[6] };

  // Load restaurant settings
  const [restaurant_row] = db
    .select({
      disabledComplianceRules: restaurants.disabledComplianceRules,
      overtimeMode: restaurants.overtimeMode,
      overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
      timezone: restaurants.timezone,
    })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();
  const disabledRules = new Set<string>(
    JSON.parse(restaurant_row?.disabledComplianceRules || "[]"),
  );
  const otMode = restaurant_row?.overtimeMode ?? "flexible";
  const otCap = otMode === "strict" ? 39 : otMode === "controlled" ? (restaurant_row?.overtimeWeeklyCap ?? 48) : 48;
  const restaurantTimezone = restaurant_row?.timezone ?? "Europe/Paris";

  /** Skip check if rule is disabled */
  const isEnabled = (code: string) => !disabledRules.has(code);

  // Fetch all non-cancelled services for this week
  const weekServices = db
    .select({
      id: services.id,
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      role: services.role,
      status: services.status,
      createdAt: services.createdAt,
      updatedAt: services.updatedAt,
    })
    .from(services)
    .where(
      and(
        eq(services.restaurantId, restaurantId),
        gte(services.date, dates[0]),
        lte(services.date, dates[6]),
        ne(services.status, "cancelled"),
      )
    )
    .orderBy(services.date, services.startTime)
    .all();

  // Also fetch adjacent days for rest-between-services check
  // Day before Monday and day after Sunday
  const dayBefore = new Date(mondayStr + "T12:00:00");
  dayBefore.setDate(dayBefore.getDate() - 1);
  const dayBeforeStr = dayBefore.toISOString().split("T")[0];
  const dayAfter = new Date(dates[6] + "T12:00:00");
  dayAfter.setDate(dayAfter.getDate() + 1);
  const dayAfterStr = dayAfter.toISOString().split("T")[0];

  const adjacentServices = db
    .select({
      id: services.id,
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
    })
    .from(services)
    .where(
      and(
        eq(services.restaurantId, restaurantId),
        ne(services.status, "cancelled"),
        // Only the day before and after
        gte(services.date, dayBeforeStr),
        lte(services.date, dayAfterStr),
      )
    )
    .orderBy(services.date, services.startTime)
    .all()
    // Exclude the week itself to avoid double-counting
    .filter(s => s.date === dayBeforeStr || s.date === dayAfterStr);

  // For 12-week average, fetch previous 11 weeks
  const elevenWeeksBack = new Date(mondayStr + "T12:00:00");
  elevenWeeksBack.setDate(elevenWeeksBack.getDate() - 77); // 11 × 7
  const prevWeeksServices = db
    .select({
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
    })
    .from(services)
    .where(
      and(
        eq(services.restaurantId, restaurantId),
        gte(services.date, elevenWeeksBack.toISOString().split("T")[0]),
        lte(services.date, dayBeforeStr), // up to (not including) current week
        ne(services.status, "cancelled"),
      )
    )
    .all();

  // Public holidays that fall within this week (from calendar_events populated by refreshCalendarEvents)
  const holidayRows = db
    .select({ date: calendarEvents.date, name: calendarEvents.name })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.restaurantId, restaurantId),
        eq(calendarEvents.type, "public_holiday"),
        gte(calendarEvents.date, dates[0]),
        lte(calendarEvents.date, dates[6]),
      ),
    )
    .all();
  const holidayByDate = new Map<string, string>(holidayRows.map(h => [h.date, h.name]));

  // For consecutive days check, also look 6 days before Monday
  const sixDaysBefore = new Date(mondayStr + "T12:00:00");
  sixDaysBefore.setDate(sixDaysBefore.getDate() - 6);
  const consecutiveServices = db
    .select({
      workerId: services.workerId,
      date: services.date,
    })
    .from(services)
    .where(
      and(
        eq(services.restaurantId, restaurantId),
        gte(services.date, sixDaysBefore.toISOString().split("T")[0]),
        lte(services.date, dayAfterStr),
        ne(services.status, "cancelled"),
      )
    )
    .all();

  // Fetch workers (active only — inactive workers' past services still checked via byWorker loop)
  const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });
  const workerList = workerIds.length > 0
    ? db
      .select({ id: users.id, name: users.name, role: users.role, subRoles: users.subRoles, maxWeeklyHours: users.maxWeeklyHours, adminOtOverride: users.adminOtOverride })
      .from(users)
      .where(and(inArray(users.id, workerIds), ne(users.role, "admin")))
      .all()
    : [];
  const knownWorkerIds = new Set(workerList.map((worker) => worker.id));
  for (const worker of listSchedulingRosterWorkers(restaurantId, ["kitchen", "floor"])) {
    if (knownWorkerIds.has(worker.id)) continue;
    workerList.push({
      id: worker.id,
      name: worker.name,
      role: worker.role,
      subRoles: worker.subRoles,
      maxWeeklyHours: worker.maxWeeklyHours,
      adminOtOverride: null,
    });
    knownWorkerIds.add(worker.id);
  }

  const workerNames = new Map(workerList.map(w => [w.id, w.name]));
  const workerRoles = new Map(workerList.map(w => [w.id, w.role]));
  const workerIsChef = new Map(workerList.map(w => {
    try { return [w.id, hasChefLabel(JSON.parse(w.subRoles || "[]") as string[])] as const; }
    catch { return [w.id, false] as const; }
  }));
  // Effective per-worker weekly cap (for the tighter "dépasse le plafond personnel" warning).
  // The legal HCR 48h hard-max (RULES.MAX_WEEKLY_HOURS) stays as a separate error check below.
  const workerEffectiveCap = new Map<string, number | null>(workerList.map(w => {
    const base = w.adminOtOverride ?? null;
    const pref = w.maxWeeklyHours ?? null;
    let cap: number | null = null;
    if (pref != null && base != null) cap = Math.min(pref, base);
    else if (pref != null) cap = pref;
    else if (base != null) cap = base;
    return [w.id, cap];
  }));

  // Group week services by worker
  const byWorker = new Map<string, typeof weekServices>();
  for (const s of weekServices) {
    if (!byWorker.has(s.workerId)) byWorker.set(s.workerId, []);
    byWorker.get(s.workerId)!.push(s);
  }

  const violations: ComplianceViolation[] = [];
  const overtime: OvertimeEntry[] = [];

  for (const [workerId, workerServices] of byWorker) {
    const workerName = workerNames.get(workerId) || "Unknown";

    // ── 1. Max daily hours ──
    const byDate = new Map<string, typeof workerServices>();
    for (const s of workerServices) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s);
    }

    for (const [date, dayServices] of byDate) {
      const totalHours = dayServices.reduce((sum, s) => sum + serviceHours(s.startTime, s.endTime), 0);

      // ── Public holiday flags ──
      // Assignments on jours fériés get tagged so payroll applies the premium.
      // May 1 (Fête du Travail) is a stronger warning — legally mandated double-time.
      const holidayName = holidayByDate.get(date);
      if (holidayName) {
        const isMay1 = date.endsWith("-05-01");
        if (isMay1 && isEnabled(RULES.MAY_1_DOUBLE_PAY.code)) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.MAY_1_DOUBLE_PAY.label,
            code: RULES.MAY_1_DOUBLE_PAY.code,
            severity: "warning",
            message: `${totalHours.toFixed(1)}h le 1er mai — majoration 100% obligatoire (taux horaire × 2)`,
            detail: RULES.MAY_1_DOUBLE_PAY.description,
            date,
            value: totalHours,
          });
        } else if (isEnabled(RULES.PUBLIC_HOLIDAY_WORK.code)) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.PUBLIC_HOLIDAY_WORK.label,
            code: RULES.PUBLIC_HOLIDAY_WORK.code,
            severity: "info",
            message: `${totalHours.toFixed(1)}h travaillées le ${holidayName}`,
            detail: RULES.PUBLIC_HOLIDAY_WORK.description,
            date,
            value: totalHours,
          });
        }
      }

      // Role-specific daily hour cap (HCR convention)
      const wRole = workerRoles.get(workerId);
      const isKitchenChef = wRole === "kitchen" && workerIsChef.get(workerId);
      const roleLimit = isKitchenChef
        ? RULES.MAX_DAILY_HOURS.kitchenChefLimit   // 11h for chef de cuisine
        : wRole === "floor"
          ? RULES.MAX_DAILY_HOURS.salleLimit        // 11h30 for serveur
          : RULES.MAX_DAILY_HOURS.exceptionalLimit; // 11h fallback
      const roleLimitLabel = isKitchenChef ? "chef cuisine" : wRole === "floor" ? "serveur" : "";

      if (isEnabled(RULES.MAX_DAILY_HOURS.code)) {
        if (totalHours > roleLimit) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.MAX_DAILY_HOURS.label,
            code: RULES.MAX_DAILY_HOURS.code,
            severity: "error",
            message: `${totalHours.toFixed(1)}h travaillées — dépasse le max de ${roleLimit}h${roleLimitLabel ? ` (${roleLimitLabel})` : ""}`,
            detail: RULES.MAX_DAILY_HOURS.description,
            date,
            value: totalHours,
            limit: roleLimit,
          });
        } else if (totalHours > RULES.MAX_DAILY_HOURS.limit) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.MAX_DAILY_HOURS.label,
            code: RULES.MAX_DAILY_HOURS.code,
            severity: "warning",
            message: `${totalHours.toFixed(1)}h travaillées — dépasse les ${RULES.MAX_DAILY_HOURS.limit}h (max ${roleLimitLabel || "exceptionnel"}: ${roleLimit}h)`,
            detail: RULES.MAX_DAILY_HOURS.description,
            date,
            value: totalHours,
            limit: RULES.MAX_DAILY_HOURS.limit,
          });
        }
      }

      // ── Amplitude check (13h max between first start and last end) ──
      if (isEnabled(RULES.MAX_AMPLITUDE.code) && dayServices.length > 1) {
        const firstStartMin = Math.min(...dayServices.map(s => timeToMinutes(s.startTime)));
        let lastEndMin = 0;
        for (const s of dayServices) {
          let endMin = timeToMinutes(s.endTime);
          if (endMin < timeToMinutes(s.startTime)) endMin += 24 * 60; // overnight
          lastEndMin = Math.max(lastEndMin, endMin);
        }
        const amplitudeHours = (lastEndMin - firstStartMin) / 60;
        if (amplitudeHours > RULES.MAX_AMPLITUDE.limit) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.MAX_AMPLITUDE.label,
            code: RULES.MAX_AMPLITUDE.code,
            severity: "error",
            message: `Amplitude de ${amplitudeHours.toFixed(1)}h — dépasse le max de ${RULES.MAX_AMPLITUDE.limit}h`,
            detail: RULES.MAX_AMPLITUDE.description,
            date,
            value: amplitudeHours,
            limit: RULES.MAX_AMPLITUDE.limit,
          });
        }
      }

      // ── 7. Break after 6h ──
      // Check if any single service exceeds 6h (we can't verify break was taken without break tracking)
      if (isEnabled(RULES.BREAK_6H.code)) for (const s of dayServices) {
        const hours = serviceHours(s.startTime, s.endTime);
        if (hours > RULES.BREAK_6H.limit) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.BREAK_6H.label,
            code: RULES.BREAK_6H.code,
            severity: "info",
            message: `Service de ${hours.toFixed(1)}h sans pause vérifiable (>${RULES.BREAK_6H.limit}h)`,
            detail: `${RULES.BREAK_6H.description}. Vérifiez qu'une pause de ${RULES.BREAK_6H.breakMinutes} min est prévue.`,
            date,
            value: hours,
            limit: RULES.BREAK_6H.limit,
          });
        }
      }
    }

    // ── 2. Max weekly hours ──
    const weeklyHours = workerServices.reduce((sum, s) => sum + serviceHours(s.startTime, s.endTime), 0);

    if (isEnabled(RULES.MAX_WEEKLY_HOURS.code) && weeklyHours > RULES.MAX_WEEKLY_HOURS.limit) {
      violations.push({
        workerId,
        workerName,
        rule: RULES.MAX_WEEKLY_HOURS.label,
        code: RULES.MAX_WEEKLY_HOURS.code,
        severity: "error",
        message: `${weeklyHours.toFixed(1)}h cette semaine — dépasse le max absolu de ${RULES.MAX_WEEKLY_HOURS.limit}h`,
        detail: RULES.MAX_WEEKLY_HOURS.description,
        value: weeklyHours,
        limit: RULES.MAX_WEEKLY_HOURS.limit,
      });
    }

    // Per-worker personal cap check (tighter than legal 48h when worker preference or admin override is set).
    // Fires as a warning — it's a configuration choice, not a legal violation.
    const personalCap = workerEffectiveCap.get(workerId) ?? null;
    if (isEnabled(RULES.MAX_WEEKLY_HOURS.code) && personalCap != null && personalCap < RULES.MAX_WEEKLY_HOURS.limit && weeklyHours > personalCap) {
      violations.push({
        workerId,
        workerName,
        rule: RULES.MAX_WEEKLY_HOURS.label,
        code: RULES.MAX_WEEKLY_HOURS.code,
        severity: "warning",
        message: `${weeklyHours.toFixed(1)}h cette semaine — dépasse le plafond de ${personalCap}h configuré pour cet employé`,
        detail: "Ce plafond personnel combine la préférence de l'employé et l'override du gérant.",
        value: weeklyHours,
        limit: personalCap,
      });
    }

    // ── 3. Average weekly hours over 12 weeks ──
    // Compute hours per week for previous 11 weeks + current
    const workerPrevServices = prevWeeksServices.filter(s => s.workerId === workerId);
    const weeklyTotals: number[] = [];

    // Previous 11 weeks
    for (let w = 0; w < 11; w++) {
      const wMonday = new Date(elevenWeeksBack.getTime());
      wMonday.setDate(elevenWeeksBack.getDate() + w * 7);
      const wMondayStr = wMonday.toISOString().split("T")[0];
      const wSunday = new Date(wMonday);
      wSunday.setDate(wMonday.getDate() + 6);
      const wSundayStr = wSunday.toISOString().split("T")[0];

      const wServices = workerPrevServices.filter(s => s.date >= wMondayStr && s.date <= wSundayStr);
      const wHours = wServices.reduce((sum, s) => sum + serviceHours(s.startTime, s.endTime), 0);
      weeklyTotals.push(wHours);
    }
    // Current week
    weeklyTotals.push(weeklyHours);

    // Only check if we have meaningful data (at least a few weeks with services)
    const weeksWithData = weeklyTotals.filter(h => h > 0).length;
    if (isEnabled(RULES.AVG_WEEKLY_HOURS_12W.code) && weeksWithData >= 4) {
      const avg = weeklyTotals.reduce((a, b) => a + b, 0) / 12;
      if (avg > RULES.AVG_WEEKLY_HOURS_12W.limit) {
        violations.push({
          workerId,
          workerName,
          rule: RULES.AVG_WEEKLY_HOURS_12W.label,
          code: RULES.AVG_WEEKLY_HOURS_12W.code,
          severity: "error",
          message: `Moyenne ${avg.toFixed(1)}h/sem sur 12 semaines — dépasse ${RULES.AVG_WEEKLY_HOURS_12W.limit}h`,
          detail: RULES.AVG_WEEKLY_HOURS_12W.description,
          value: avg,
          limit: RULES.AVG_WEEKLY_HOURS_12W.limit,
        });
      }
    }

    // ── 4. Overtime calculation ──
    if (isEnabled(RULES.OVERTIME_THRESHOLD.code) && weeklyHours > RULES.OVERTIME_THRESHOLD.limit) {
      const ot = weeklyHours - RULES.OVERTIME_THRESHOLD.limit;
      const rate110 = Math.min(ot, 4); // h40-h43
      const rate120 = Math.min(Math.max(ot - 4, 0), 4); // h44-h47
      const rate150 = Math.max(ot - 8, 0); // h48+

      overtime.push({
        workerId,
        workerName,
        weeklyHours,
        overtimeHours: ot,
        breakdown: { rate110, rate120, rate150 },
      });

      violations.push({
        workerId,
        workerName,
        rule: RULES.OVERTIME_THRESHOLD.label,
        code: RULES.OVERTIME_THRESHOLD.code,
        severity: "info",
        message: `${ot.toFixed(1)}h supplémentaires (${weeklyHours.toFixed(1)}h total)`,
        detail: `${RULES.OVERTIME_THRESHOLD.description}. 110%: ${rate110.toFixed(1)}h, 120%: ${rate120.toFixed(1)}h, 150%: ${rate150.toFixed(1)}h`,
        value: weeklyHours,
        limit: RULES.OVERTIME_THRESHOLD.limit,
      });
    }

    // ── 5. Minimum rest between services ──
    // Combine week + adjacent day services, sorted by date+start
    const allWorkerServices = [
      ...adjacentServices.filter(s => s.workerId === workerId),
      ...workerServices,
    ].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

    // For daily rest check: find the last service end of each working day,
    // and the first service start of the next working day.
    // Same-day gaps (e.g. midi→soir break) are NOT daily rest violations.
    const workerDateServices = new Map<string, typeof allWorkerServices>();
    for (const s of allWorkerServices) {
      if (!workerDateServices.has(s.date)) workerDateServices.set(s.date, []);
      workerDateServices.get(s.date)!.push(s);
    }

    const workerDates = [...workerDateServices.keys()].sort();
    for (let di = 0; di < workerDates.length - 1; di++) {
      const currentDate = workerDates[di];
      const nextDate = workerDates[di + 1];

      // Only check pairs where at least one date is in the current week
      if (currentDate < dates[0] && nextDate < dates[0]) continue;
      if (currentDate > dates[6] && nextDate > dates[6]) continue;

      const currentDayServices = workerDateServices.get(currentDate)!;
      const nextDayServices = workerDateServices.get(nextDate)!;

      // Last service end of current day (handle overnight: endTime < startTime)
      let lastEndMinutes = 0;
      for (const s of currentDayServices) {
        let endMin = timeToMinutes(s.endTime);
        if (endMin < timeToMinutes(s.startTime)) endMin += 24 * 60; // overnight
        lastEndMinutes = Math.max(lastEndMinutes, endMin);
      }

      // First service start of next day
      const firstStart = nextDayServices.reduce(
        (min, s) => Math.min(min, timeToMinutes(s.startTime)),
        Infinity,
      );

      // Calculate rest between last end of current day and first start of next day
      const daysBetween = Math.round(
        (new Date(nextDate + "T12:00:00").getTime() - new Date(currentDate + "T12:00:00").getTime()) /
        (24 * 60 * 60 * 1000)
      );

      const toMidnight = (24 * 60) - lastEndMinutes;
      const fromMidnight = firstStart;
      const fullDaysMinutes = Math.max(0, daysBetween - 1) * 24 * 60;
      const restMinutes = toMidnight + fromMidnight + fullDaysMinutes;

      const restHours = restMinutes / 60;
      const current = currentDayServices[currentDayServices.length - 1]; // for display
      const next = nextDayServices[0]; // for display

      if (isEnabled(RULES.MIN_DAILY_REST.code)) {
        if (restHours < RULES.MIN_DAILY_REST.hcrDerogation) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.MIN_DAILY_REST.label,
            code: RULES.MIN_DAILY_REST.code,
            severity: "error",
            message: `${restHours.toFixed(1)}h de repos entre ${currentDate} (fin ${current.endTime}) et ${nextDate} (début ${next.startTime}) — sous le min HCR de ${RULES.MIN_DAILY_REST.hcrDerogation}h`,
            detail: RULES.MIN_DAILY_REST.description,
            date: nextDate,
            value: restHours,
            limit: RULES.MIN_DAILY_REST.hcrDerogation,
          });
        } else if (restHours < RULES.MIN_DAILY_REST.limit) {
          violations.push({
            workerId,
            workerName,
            rule: RULES.MIN_DAILY_REST.label,
            code: RULES.MIN_DAILY_REST.code,
            severity: "warning",
            message: `${restHours.toFixed(1)}h de repos entre ${currentDate} et ${nextDate} — sous le standard de ${RULES.MIN_DAILY_REST.limit}h (HCR autorise ${RULES.MIN_DAILY_REST.hcrDerogation}h)`,
            detail: RULES.MIN_DAILY_REST.description,
            date: nextDate,
            value: restHours,
            limit: RULES.MIN_DAILY_REST.limit,
          });
        }
      }
    }

    // ── 6. Max consecutive working days ──
    const workerConsecutive = consecutiveServices
      .filter(s => s.workerId === workerId)
      .map(s => s.date);
    const uniqueDates = [...new Set(workerConsecutive)].sort();

    // Find longest consecutive run that overlaps with current week
    let maxRun = 1;
    let currentRun = 1;
    let runStart = uniqueDates[0];

    for (let i = 1; i < uniqueDates.length; i++) {
      const prev = new Date(uniqueDates[i - 1] + "T12:00:00");
      const curr = new Date(uniqueDates[i] + "T12:00:00");
      const dayDiff = Math.round((curr.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));

      if (dayDiff === 1) {
        currentRun++;
        if (currentRun > maxRun) {
          maxRun = currentRun;
        }
      } else {
        currentRun = 1;
        runStart = uniqueDates[i];
      }
    }

    if (isEnabled(RULES.MAX_CONSECUTIVE_DAYS.code) && maxRun > RULES.MAX_CONSECUTIVE_DAYS.limit) {
      violations.push({
        workerId,
        workerName,
        rule: RULES.MAX_CONSECUTIVE_DAYS.label,
        code: RULES.MAX_CONSECUTIVE_DAYS.code,
        severity: "error",
        message: `${maxRun} jours consécutifs travaillés — max ${RULES.MAX_CONSECUTIVE_DAYS.limit}`,
        detail: RULES.MAX_CONSECUTIVE_DAYS.description,
        value: maxRun,
        limit: RULES.MAX_CONSECUTIVE_DAYS.limit,
      });
    }

    // ── 7. Weekly rest days ──
    if (isEnabled(RULES.WEEKLY_REST.code)) {
      const daysWorked = new Set(workerServices.map(s => s.date)).size;
      const daysOff = 7 - daysWorked;

      if (daysOff < RULES.WEEKLY_REST.hcrMinimum) {
        violations.push({
          workerId,
          workerName,
          rule: RULES.WEEKLY_REST.label,
          code: RULES.WEEKLY_REST.code,
          severity: "error",
          message: `${daysOff} jour(s) de repos cette semaine — minimum ${RULES.WEEKLY_REST.hcrMinimum} (HCR)`,
          detail: RULES.WEEKLY_REST.description,
          value: daysOff,
          limit: RULES.WEEKLY_REST.hcrMinimum,
        });
      } else if (daysOff < RULES.WEEKLY_REST.limit) {
        violations.push({
          workerId,
          workerName,
          rule: RULES.WEEKLY_REST.label,
          code: RULES.WEEKLY_REST.code,
          severity: "warning",
          message: `${daysOff} jour(s) de repos — standard est ${RULES.WEEKLY_REST.limit}, HCR autorise ${RULES.WEEKLY_REST.hcrMinimum}`,
          detail: RULES.WEEKLY_REST.description,
          value: daysOff,
          limit: RULES.WEEKLY_REST.limit,
        });
      }
    }
  }

  // ── 9. Overtime policy check ──
  if (isEnabled(RULES.OVERTIME_POLICY.code) && otMode !== "flexible") {
    for (const [workerId, workerServices] of byWorker) {
      const workerName = workerNames.get(workerId) || "Unknown";
      const weeklyHrs = workerServices.reduce((sum, s) => sum + serviceHours(s.startTime, s.endTime), 0);

      if (otMode === "strict" && weeklyHrs > 39) {
        const otHrs = weeklyHrs - 39;
        violations.push({
          workerId,
          workerName,
          rule: RULES.OVERTIME_POLICY.label,
          code: RULES.OVERTIME_POLICY.code,
          severity: "error",
          message: `${otHrs.toFixed(1)}h supplémentaires — la politique STRICT interdit les heures sup`,
          detail: `${workerName}: ${weeklyHrs.toFixed(1)}h cette semaine. Politique: aucune heure supplémentaire.`,
          value: weeklyHrs,
          limit: 39,
        });
      } else if (otMode === "controlled" && weeklyHrs > otCap) {
        const excess = weeklyHrs - otCap;
        violations.push({
          workerId,
          workerName,
          rule: RULES.OVERTIME_POLICY.label,
          code: RULES.OVERTIME_POLICY.code,
          severity: "warning",
          message: `${weeklyHrs.toFixed(1)}h cette semaine — dépasse le plafond de ${otCap}h (excès: ${excess.toFixed(1)}h)`,
          detail: `${workerName}: plafond hebdomadaire fixé à ${otCap}h en mode contrôlé.`,
          value: weeklyHrs,
          limit: otCap,
        });
      }
    }
  }


  // ── 11. Advance notice — planning should be communicated 15 days before period start ──
  if (isEnabled(RULES.ADVANCE_NOTICE.code) && weekServices.length > 0) {
    const published = db.select({ publishedAt: publishedWeeks.publishedAt })
      .from(publishedWeeks)
      .where(and(
        eq(publishedWeeks.restaurantId, restaurantId),
        eq(publishedWeeks.weekDate, week.from),
      ))
      .get();

    if (published) {
      const publishedDate = todayInTimeZone(restaurantTimezone, parseServerTimestamp(published.publishedAt));
      const leadDays = calendarDaysBetween(publishedDate, week.from);
      if (leadDays < RULES.ADVANCE_NOTICE.limit) {
        violations.push({
          workerId: "__schedule__",
          workerName: "Planning",
          rule: RULES.ADVANCE_NOTICE.label,
          code: RULES.ADVANCE_NOTICE.code,
          severity: "warning",
          message: `Semaine publiée ${leadDays} jour(s) avant le début — délai HCR: ${RULES.ADVANCE_NOTICE.limit} jours`,
          detail: `${RULES.ADVANCE_NOTICE.description}. Date de publication: ${publishedDate}.`,
          date: week.from,
          value: leadDays,
          limit: RULES.ADVANCE_NOTICE.limit,
        });
      }
    } else {
      const today = todayInTimeZone(restaurantTimezone);
      const daysUntilStart = calendarDaysBetween(today, week.from);
      if (daysUntilStart < RULES.ADVANCE_NOTICE.limit) {
        const deadlinePassed = daysUntilStart < 0;
        violations.push({
          workerId: "__schedule__",
          workerName: "Planning",
          rule: RULES.ADVANCE_NOTICE.label,
          code: RULES.ADVANCE_NOTICE.code,
          severity: "warning",
          message: deadlinePassed
            ? `Semaine du ${week.from} non publiée — délai HCR de ${RULES.ADVANCE_NOTICE.limit} jours dépassé`
            : `Semaine du ${week.from} non publiée à J-${daysUntilStart} — délai HCR: ${RULES.ADVANCE_NOTICE.limit} jours`,
          detail: `${RULES.ADVANCE_NOTICE.description}. Publier la semaine la rend visible aux employés.`,
          date: week.from,
          value: Math.max(daysUntilStart, 0),
          limit: RULES.ADVANCE_NOTICE.limit,
        });
      }
    }
  }

  // ── 12. Modification notice — 8 days before shift date ──
  if (isEnabled(RULES.MODIFICATION_NOTICE.code)) {
    for (const s of weekServices) {
      const created = new Date(s.createdAt);
      const updated = new Date(s.updatedAt);
      // Only flag if actually modified (updatedAt > createdAt by >1min to avoid precision noise)
      if (updated.getTime() - created.getTime() < 60_000) continue;
      const shiftDate = new Date(s.date + "T12:00:00");
      const leadDays = Math.round((shiftDate.getTime() - updated.getTime()) / (24 * 60 * 60 * 1000));
      if (leadDays < RULES.MODIFICATION_NOTICE.limit) {
        const wName = workerNames.get(s.workerId) || "Inconnu";
        violations.push({
          workerId: s.workerId,
          workerName: wName,
          rule: RULES.MODIFICATION_NOTICE.label,
          code: RULES.MODIFICATION_NOTICE.code,
          severity: "warning",
          message: `Shift du ${s.date} modifié ${leadDays}j avant — le salarié peut refuser (délai légal: ${RULES.MODIFICATION_NOTICE.limit}j)`,
          detail: RULES.MODIFICATION_NOTICE.description,
          date: s.date,
          value: leadDays,
          limit: RULES.MODIFICATION_NOTICE.limit,
        });
      }
    }
  }

  // ── HCR-CONGES-PAYES-MINIMUM ──
  // Quiet most of the year; surfaces warnings only when a worker has >10 CP days
  // still to take and <3 months left in the June 1 → May 31 reference period.
  // The balance itself always lives on /holidays — this rule just pages the admin.
  if (isEnabled(RULES.PAID_LEAVE_MINIMUM.code)) {
    const balances = computeLeaveBalances(restaurantId);
    for (const b of balances) {
      if (!b.expiringSoon) continue;
      violations.push({
        workerId: b.workerId,
        workerName: b.workerName,
        rule: RULES.PAID_LEAVE_MINIMUM.label,
        code: RULES.PAID_LEAVE_MINIMUM.code,
        severity: "warning",
        message: `${b.workerName} n'a pas encore posé ${b.remainingDays} jours de CP — à poser avant le 31 mai`,
        detail: RULES.PAID_LEAVE_MINIMUM.description,
        value: b.remainingDays,
        limit: 0,
      });
    }
  }

  // Sort violations: errors first, then warnings, then info
  const severityOrder: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  violations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    week,
    violations,
    overtime,
    summary: {
      errors: violations.filter(v => v.severity === "error").length,
      warnings: violations.filter(v => v.severity === "warning").length,
      info: violations.filter(v => v.severity === "info").length,
      workersChecked: byWorker.size,
    },
  };
}
