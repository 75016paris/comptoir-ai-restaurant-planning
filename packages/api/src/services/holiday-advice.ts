/**
 * Holiday advice — recommend when/how to schedule leaves based on:
 *   1. persistent role-level surplus capacity (staffing-analysis)
 *   2. upcoming quiet periods (school vacations + public holidays from calendar_events)
 *   3. employee leave balances (earned — deduped against already-taken)
 *
 * Output: per-role leave suggestions admins can act on.
 */

import { db } from "../db/connection.js";
import { calendarEvents, users, holidayRequests } from "../db/schema.js";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import type { StaffingAnalysis } from "./staffing-analysis.js";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";

type Role = "kitchen" | "floor";

export type QuietPeriodSuggestion = {
  start: string;         // YYYY-MM-DD
  end: string;           // YYYY-MM-DD
  durationDays: number;
  label: string;         // "Vacances de la Toussaint (zone C)" etc.
  source: "school_vacation" | "public_holiday";
};

export type HolidayAdviceForRole = {
  role: Role;
  surplusHoursPerWeek: number;     // average weekly surplus (negative = understaffed)
  workerWeeksAbsorbable: number;   // how many worker-weeks of leave the surplus can absorb
  candidatePeriods: QuietPeriodSuggestion[];   // upcoming quiet periods worth considering
  recommendation: string;          // human-readable French summary
  priority: "high" | "medium" | "low" | "none";
};

export type HolidayAdvice = {
  generatedAt: string;
  byRole: HolidayAdviceForRole[];
  upcomingQuietPeriods: QuietPeriodSuggestion[];  // all within 6 months, both roles can share
  workerSuggestions: WorkerLeaveSuggestion[];     // concrete per-worker → period recommendations
};

const WEEKS_HORIZON = 26; // look ~6 months ahead

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

function daysBetween(a: string, b: string): number {
  const ad = new Date(a + "T12:00:00").getTime();
  const bd = new Date(b + "T12:00:00").getTime();
  return Math.max(1, Math.round((bd - ad) / (24 * 3600 * 1000)) + 1);
}

// Jours ouvrables (Mon-Sat) inclusive between two YYYY-MM-DD dates.
// French CP is counted in ouvrables: 30 days/year = 5 weeks × 6 days.
// Sundays don't count even when the restaurant is open — that's the
// Code du travail convention (L3141-3) the earnedDays formula relies on.
function workingDaysBetween(a: string, b: string): number {
  const start = new Date(a + "T12:00:00");
  const end = new Date(b + "T12:00:00");
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getDay() !== 0) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, count);
}

function loadUpcomingQuietPeriods(restaurantId: string): QuietPeriodSuggestion[] {
  const today = fmtDate(new Date());
  const horizonEnd = fmtDate(new Date(Date.now() + WEEKS_HORIZON * 7 * 24 * 3600 * 1000));

  const events = db.select({
    type: calendarEvents.type,
    date: calendarEvents.date,
    endDate: calendarEvents.endDate,
    name: calendarEvents.name,
  }).from(calendarEvents)
    .where(and(
      eq(calendarEvents.restaurantId, restaurantId),
      gte(calendarEvents.date, today),
      lte(calendarEvents.date, horizonEnd),
    )).all();

  return events.map(e => ({
    start: e.date,
    end: e.endDate ?? e.date,
    durationDays: daysBetween(e.date, e.endDate ?? e.date),
    label: e.name,
    source: e.type as "school_vacation" | "public_holiday",
  })).sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Build the holiday advice from an existing StaffingAnalysis (reuses its surplus computation).
 * The analysis is already computed via /settings/staffing-analysis; this service post-processes it.
 */
export function computeHolidayAdvice(restaurantId: string, analysis: StaffingAnalysis): HolidayAdvice {
  const upcoming = loadUpcomingQuietPeriods(restaurantId);
  // Prefer multi-day school vacations (better candidates than 1-day holidays for leave blocks).
  const multiDayPeriods = upcoming.filter(p => p.durationDays >= 5);

  const byRole: HolidayAdviceForRole[] = [];
  for (const role of ["kitchen", "floor"] as Role[]) {
    const cap = analysis.capacity.find(c => c.role === role);
    if (!cap) continue;
    const surplus = cap.surplusHours;
    // Average contract hours in this role — for "how many worker-weeks"
    const roleWorkers = analysis.workerLoads.filter(w => w.role === role);
    const avgContract = roleWorkers.length > 0
      ? roleWorkers.reduce((s, w) => s + (w.contractHours ?? 35), 0) / roleWorkers.length
      : 35;
    const workerWeeks = avgContract > 0 ? Math.round((surplus / avgContract) * 10) / 10 : 0;

    // Priority
    let priority: HolidayAdviceForRole["priority"] = "none";
    if (surplus > 0.3 * cap.totalDemandHours) priority = "high";
    else if (surplus > 0.1 * cap.totalDemandHours) priority = "medium";
    else if (surplus > 0) priority = "low";

    // Recommendation text
    let recommendation = "";
    const roleLabel = role === "kitchen" ? "cuisine" : "floor";
    if (priority === "none") {
      recommendation = `Aucun surplus exploitable en ${roleLabel} — les congés doivent venir des soldes acquis des employés.`;
    } else if (workerWeeks < 0.5) {
      recommendation = `Marge faible en ${roleLabel} (+${surplus}h/sem) — environ ${workerWeeks.toFixed(1)} semaines-employé mobilisables avant impact.`;
    } else {
      const quietLabels = multiDayPeriods.slice(0, 2).map(p => p.label).join(" ou ");
      recommendation = `Équipe ${roleLabel} sur-dimensionnée de ${surplus}h/sem (~${workerWeeks.toFixed(1)} semaines-employé absorbables). Candidats idéals : ${quietLabels || "prochaines vacances scolaires"}.`;
    }

    byRole.push({
      role,
      surplusHoursPerWeek: surplus,
      workerWeeksAbsorbable: workerWeeks,
      candidatePeriods: multiDayPeriods.slice(0, 3),
      recommendation,
      priority,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    byRole,
    upcomingQuietPeriods: upcoming,
    workerSuggestions: [],
  };
}

/** Per-worker leave balance (earned - taken) for the payroll year.
 *  Uses French rules: 2.5 days / month of work effective → 30 days/year max.
 *  Year starts June 1 per French labor code (période de référence 1 juin → 31 mai).
 */
export type LeaveBalance = {
  workerId: string;
  workerName: string;
  role: Role;
  earnedDays: number;    // estimated
  takenDays: number;
  remainingDays: number;
  /** Prior-period CP still not consumed by current-period approved leave. */
  expiringDays: number;
  expiringSoon: boolean;
};

/** Per-worker leave-balance urgency signal, in [0, 1].
 *  Fed to the solver as a soft penalty: higher urgency → the solver prefers OTHER
 *  workers, leaving this one space to actually take their CP. Composes three
 *  factors: how much is left to take, time pressure against the end of period,
 *  and the hard `expiringSoon` flag for prior-period carryover. */
export type LeaveUrgency = {
  workerId: string;
  urgency: number;
  remainingDays: number;
  expiringSoon: boolean;
};

const LEGAL_ANNUAL_CP_DAYS = 30;

function earnedDaysBetween(joinDate: Date, periodStart: string, periodEndExclusive: Date): number {
  const start = joinDate > new Date(periodStart + "T12:00:00")
    ? joinDate
    : new Date(periodStart + "T12:00:00");
  if (start >= periodEndExclusive) return 0;
  const monthsWorked = Math.max(0, Math.min(12, Math.floor(
    ((periodEndExclusive.getTime() - start.getTime()) / (30.44 * 24 * 3600 * 1000)) + 0.2,
  )));
  return Math.round(monthsWorked * 2.5 * 10) / 10;
}

export function computeLeaveUrgency(balances: LeaveBalance[]): LeaveUrgency[] {
  const today = new Date();
  const year = today.getMonth() >= 5 ? today.getFullYear() : today.getFullYear() - 1;
  const periodEnd = new Date(`${year + 1}-05-31T23:59:59`);
  const daysLeft = Math.max(0, Math.round((periodEnd.getTime() - today.getTime()) / (24 * 3600 * 1000)));
  return balances.map(b => {
    const takeFraction = Math.min(1, b.remainingDays / LEGAL_ANNUAL_CP_DAYS);
    const timePressure = 1 - daysLeft / 365;
    let urgency = takeFraction * timePressure;
    if (b.expiringSoon) urgency = Math.max(urgency, 0.7);
    urgency = Math.round(urgency * 100) / 100;
    return {
      workerId: b.workerId,
      urgency: Math.max(0, Math.min(1, urgency)),
      remainingDays: b.remainingDays,
      expiringSoon: b.expiringSoon,
    };
  });
}

export function computeLeaveBalances(restaurantId: string): LeaveBalance[] {
  // Période de référence française : 1 juin → 31 mai
  const today = new Date();
  const year = today.getMonth() >= 5 ? today.getFullYear() : today.getFullYear() - 1; // current period started June (y) if after June, else prev year
  const periodStart = `${year}-06-01`;
  const periodEnd = `${year + 1}-05-31`;
  const previousPeriodStart = `${year - 1}-06-01`;
  const previousPeriodEndExclusive = new Date(`${year}-06-01T12:00:00`);

  const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["kitchen", "floor"] });
  const workers = workerIds.length > 0
    ? db.select({ id: users.id, name: users.name, role: users.role, startDate: users.startDate, createdAt: users.createdAt })
      .from(users)
      .where(inArray(users.id, workerIds))
      .all()
    : [];

  const leaves = db.select({
    workerId: holidayRequests.workerId,
    startDate: holidayRequests.startDate,
    endDate: holidayRequests.endDate,
  }).from(holidayRequests)
    .where(and(
      eq(holidayRequests.restaurantId, restaurantId),
      inArray(holidayRequests.status, ["approved"]),
      eq(holidayRequests.medical, false),
      gte(holidayRequests.startDate, periodStart),
      lte(holidayRequests.endDate, periodEnd),
    )).all();

  // Taken days in ouvrables — must match the unit of earnedDays (2.5 ouvrables/month).
  // Calendar-day counting over-charged any leave spanning a Sunday (e.g. Mon-Sun = 7
  // calendar days but 6 ouvrables). Audit Bug H2.
  const takenByWorker = new Map<string, number>();
  for (const l of leaves) {
    const days = workingDaysBetween(l.startDate, l.endDate);
    takenByWorker.set(l.workerId, (takenByWorker.get(l.workerId) ?? 0) + days);
  }

  const periodEndDate = new Date(periodEnd + "T12:00:00");
  const msUntilEnd = periodEndDate.getTime() - today.getTime();
  const daysUntilEnd = Math.round(msUntilEnd / (24 * 3600 * 1000));

  return workers.map(w => {
    // Employment start date is the source of truth for earned-days math.
    // `createdAt` (SaaS row insertion) was wrong for restaurants onboarding
    // workers who already had years of tenure — earned days reset to zero on
    // import. Audit Bug H1.
    const joinDate = w.startDate
      ? new Date(w.startDate + "T12:00:00")
      : (w.createdAt ? new Date(w.createdAt) : new Date(periodStart));
    const earnedDays = earnedDaysBetween(joinDate, periodStart, today);  // 2.5 jours ouvrables / mois
    const takenDays = takenByWorker.get(w.id) ?? 0;
    const remaining = Math.max(0, earnedDays - takenDays);
    // The May 31 warning is about prior-period carryover, not every available
    // CP day from the current acquisition period. Current-period approved CP
    // consumes the old bucket first, FIFO-style.
    const previousEarnedDays = earnedDaysBetween(joinDate, previousPeriodStart, previousPeriodEndExclusive);
    const expiringDays = Math.max(0, Math.round((previousEarnedDays - takenDays) * 10) / 10);
    const expiringSoon =
      expiringDays > 0 &&
      (daysUntilEnd <= 30 ||
        (expiringDays >= 25 && daysUntilEnd < 180) ||
        (expiringDays >= 15 && daysUntilEnd < 120) ||
        (expiringDays >= 10 && daysUntilEnd < 90));
    return {
      workerId: w.id,
      workerName: w.name,
      role: w.role as Role,
      earnedDays,
      takenDays,
      remainingDays: remaining,
      expiringDays,
      expiringSoon,
    };
  }).sort((a, b) => b.remainingDays - a.remainingDays);
}

export type WorkerLeaveSuggestion = {
  workerId: string;
  workerName: string;
  role: Role;
  remainingDays: number;
  expiringSoon: boolean;
  /** Monday (YYYY-MM-DD) of the suggested leave week. */
  weekStart: string;
  /** Sunday (YYYY-MM-DD) of the suggested leave week. */
  weekEnd: string;
  /** Days of leave this week would consume (capped at remaining balance). */
  suggestedDays: number;
  reason: string;
  /** "closure" = imposed by a restaurant closure (fermeture annuelle);
   *  "solver" = proposed by the spread algorithm, solver-validated coverage. */
  source: "closure" | "solver";
};
