/**
 * Leave intelligence — single entry point that unifies everything leave-related
 * for the admin's decision-making on /holidays:
 *
 *   1. computeLeaveBalances  (earned/taken/remaining per worker)      — from holiday-advice
 *   2. computeHolidayAdvice  (per-role surplus + quiet periods)        — from holiday-advice
 *   3. computePendingClusters (solver-backed approve/deny per request) — extracted here
 *   4. computeLeaveCompliance (HCR-CONGES-PAYES-MINIMUM warnings)      — new
 *   5. computeLeaveUrgency    (per-worker 0..1 signal fed to solver)   — new
 *
 * The aggregator `computeLeaveIntelligence()` returns all of the above in one
 * payload so the /holidays page can render a single coherent view, and the
 * solver can consume the urgency signal without a second round-trip.
 */

import { db } from "../db/connection.js";
import { holidayRequests, users, staffingSchedule, staffingProfiles, staffingTargets, restaurantClosures } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { weekDates, isoWeekNum, isoWeekYear, isoDayOfWeek, fmtDate } from "../utils/scheduling.js";
import { computeHolidayAdvice, computeLeaveBalances, computeLeaveUrgency, type LeaveBalance, type HolidayAdvice, type LeaveUrgency, type WorkerLeaveSuggestion } from "./holiday-advice.js";
import { analyzeStaffing } from "./staffing-analysis.js";
import { computeOtCapacity } from "./multi-week-solver.js";
import { restaurants } from "../db/schema.js";
import { generatePlan } from "../routes/autostaffing.js";

export type PendingClusterRecommendation = {
  holidayId: string;
  workerName: string;
  workerRole: string;
  startDate: string;
  endDate: string;
  recommendation: "approve" | "deny";
  reason: string;
  unfillableSlots?: Array<{ dayOfWeek: number; zone: string; role: string; filled: number; filledBaseline: number; target: number }>;
  /** Cross-enrichment: balance context for this worker at review time. */
  balanceContext?: {
    remainingDays: number;
    expiringSoon: boolean;
  };
};

export type PendingCluster = {
  holidays: PendingClusterRecommendation[];
  approveCount: number;
  denyCount: number;
};

export type LeaveComplianceViolation = {
  workerId: string;
  workerName: string;
  code: "HCR-CONGES-PAYES-MINIMUM";
  severity: "warning";
  remainingDays: number;
  daysUntilPeriodEnd: number;
  message: string;
};

export type { LeaveUrgency };

export type LeaveIntelligence = {
  generatedAt: string;
  balances: LeaveBalance[];
  advice: HolidayAdvice;
  pendingClusters: PendingCluster[];
  compliance: LeaveComplianceViolation[];
  urgency: LeaveUrgency[];
};

function daysUntilPeriodEnd(): number {
  const today = new Date();
  const year = today.getMonth() >= 5 ? today.getFullYear() : today.getFullYear() - 1;
  const periodEnd = new Date(`${year + 1}-05-31T23:59:59`);
  return Math.max(0, Math.round((periodEnd.getTime() - today.getTime()) / (24 * 3600 * 1000)));
}

export function computeLeaveCompliance(balances: LeaveBalance[]): LeaveComplianceViolation[] {
  const daysLeft = daysUntilPeriodEnd();
  const out: LeaveComplianceViolation[] = [];
  for (const b of balances) {
    if (!b.expiringSoon) continue;
    out.push({
      workerId: b.workerId,
      workerName: b.workerName,
      code: "HCR-CONGES-PAYES-MINIMUM",
      severity: "warning",
      remainingDays: b.expiringDays,
      daysUntilPeriodEnd: daysLeft,
      message: `${b.workerName} a un reliquat CP de période précédente (${b.expiringDays} jours) à planifier avant la clôture de période (Code du travail L3141-3, CCN HCR art. 24).`,
    });
  }
  return out;
}

/** Extract the union-find clusters + iterative solver logic from holidays.ts.
 *  Adds a balanceContext field on each recommendation so the UI can surface
 *  "22j restants, expire dans 2 mois" inline. */
export async function computePendingClusters(restaurantId: string, balances?: LeaveBalance[]): Promise<PendingCluster[]> {
  const pending = db.select({
    id: holidayRequests.id,
    workerId: holidayRequests.workerId,
    startDate: holidayRequests.startDate,
    endDate: holidayRequests.endDate,
    createdAt: holidayRequests.createdAt,
    workerName: users.name,
    workerRole: users.role,
  }).from(holidayRequests)
    .leftJoin(users, eq(holidayRequests.workerId, users.id))
    .where(and(
      eq(holidayRequests.restaurantId, restaurantId),
      eq(holidayRequests.status, "pending"),
    ))
    .orderBy(holidayRequests.createdAt)
    .all();

  if (pending.length === 0) return [];

  const parent = new Map<string, string>();
  function find(id: string): string {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
    return parent.get(id)!;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < pending.length; i++) {
    for (let j = i + 1; j < pending.length; j++) {
      const a = pending[i], b = pending[j];
      if (a.startDate <= b.endDate && b.startDate <= a.endDate) union(a.id, b.id);
    }
  }
  const clusterMap = new Map<string, typeof pending>();
  for (const h of pending) {
    const root = find(h.id);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(h);
  }

  const balanceByWorker = new Map<string, LeaveBalance>();
  if (balances) for (const b of balances) balanceByWorker.set(b.workerId, b);

  const clusters: PendingCluster[] = [];
  for (const [, group] of clusterMap) {
    group.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    const refMonday = fmtDate((() => {
      const d = new Date(group[0].startDate + "T12:00:00");
      const dow = d.getDay();
      d.setDate(d.getDate() - ((dow + 6) % 7));
      return d;
    })());

    let profileId: string | undefined;
    {
      const d = new Date(group[0].startDate + "T12:00:00");
      const dow = d.getDay();
      const mon = new Date(d);
      mon.setDate(d.getDate() - ((dow + 6) % 7));
      const monStr = fmtDate(mon);
      const weekNum = isoWeekNum(monStr);
      const weekYear = isoWeekYear(monStr);
      const [assignment] = db.select({ profileId: staffingSchedule.profileId })
        .from(staffingSchedule)
        .where(and(
          eq(staffingSchedule.restaurantId, restaurantId),
          eq(staffingSchedule.year, weekYear),
          eq(staffingSchedule.week, weekNum),
        )).limit(1).all();
      if (assignment) {
        profileId = assignment.profileId;
      } else {
        const [first] = db.select({ id: staffingProfiles.id })
          .from(staffingProfiles)
          .where(eq(staffingProfiles.restaurantId, restaurantId))
          .orderBy(staffingProfiles.sortOrder)
          .limit(1).all();
        profileId = first?.id;
      }
    }

    const targets = profileId
      ? db.select().from(staffingTargets)
          .where(and(eq(staffingTargets.restaurantId, restaurantId), eq(staffingTargets.profileId, profileId))).all()
      : [];

    const holidayDows = (h: { startDate: string; endDate: string }) => {
      const dows = new Set<number>();
      const cur = new Date(h.startDate + "T12:00:00");
      const end = new Date(h.endDate + "T12:00:00");
      while (cur <= end) {
        const jsDay = cur.getDay();
        dows.add(jsDay === 0 ? 7 : jsDay);
        cur.setDate(cur.getDate() + 1);
      }
      return dows;
    };

    const countSlotFills = (svcs: Array<{ date: string; role: string; zone: string; workerId: string }>) => {
      const map = new Map<string, Set<string>>();
      for (const s of svcs) {
        const dow = isoDayOfWeek(s.date);
        const key = `${dow}_${s.role}_${s.zone}`;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(s.workerId);
      }
      return map;
    };

    const findUnfillable = (
      fills: Map<string, Set<string>>,
      baselineFills: Map<string, Set<string>>,
      dows: Set<number>,
      workerRole: string,
    ) => {
      const result: Array<{ dayOfWeek: number; zone: string; role: string; filled: number; filledBaseline: number; target: number }> = [];
      for (const t of targets) {
        if (t.count === 0 || !dows.has(t.dayOfWeek)) continue;
        if (t.role !== workerRole) continue;
        const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
        const filled = fills.get(key)?.size ?? 0;
        const filledBaseline = baselineFills.get(key)?.size ?? 0;
        // Only flag slots where:
        //   (1) granting this leave specifically degrades coverage (filledBaseline > filled), AND
        //   (2) the degraded coverage falls below target.
        // This avoids flagging pre-existing gaps the solver can't close regardless of this leave.
        if (filledBaseline > filled && filled < t.count) {
          result.push({ dayOfWeek: t.dayOfWeek, zone: t.zone, role: t.role, filled, filledBaseline, target: t.count });
        }
      }
      return result;
    };

    const refDates = weekDates(refMonday);
    const refFrom = refDates[0];
    const refTo = refDates[6];
    const toRefAbsence = (h: { workerId: string; startDate: string; endDate: string }) => ({
      workerId: h.workerId,
      startDate: refFrom,
      endDate: refTo,
    });

    const approvedSoFar: Array<{ workerId: string; startDate: string; endDate: string }> = [];
    const results: PendingClusterRecommendation[] = [];

    for (const h of group) {
      const candidateAbsences = [...approvedSoFar, toRefAbsence(h)];
      const balance = balanceByWorker.get(h.workerId);
      const balanceContext = balance
        ? { remainingDays: balance.remainingDays, expiringSoon: balance.expiringSoon }
        : undefined;

      try {
        const [ilpResult, baselineResult] = await Promise.all([
          generatePlan(restaurantId, refMonday, undefined, {
            holidayFilter: ["approved"],
            extraAbsences: candidateAbsences,
          }),
          generatePlan(restaurantId, refMonday, undefined, {
            holidayFilter: ["approved"],
            extraAbsences: approvedSoFar,
          }),
        ]);

        const fills = countSlotFills(ilpResult.services);
        const baselineFills = countSlotFills(baselineResult.services);
        const dows = holidayDows(h);
        const workerRole = h.workerRole || "floor";
        const unfillable = findUnfillable(fills, baselineFills, dows, workerRole);

        if (unfillable.length === 0) {
          approvedSoFar.push(toRefAbsence(h));
          results.push({
            holidayId: h.id,
            workerName: h.workerName || "?",
            workerRole: h.workerRole || "floor",
            startDate: h.startDate,
            endDate: h.endDate,
            recommendation: "approve",
            reason: "L'\u00e9quipe peut couvrir tous les cr\u00e9neaux",
            balanceContext,
          });
        } else {
          const slotLabels = unfillable.map(s => {
            const dayLabel = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"][s.dayOfWeek - 1];
            return `${dayLabel} ${s.zone} (${s.filled}/${s.target})`;
          });
          results.push({
            holidayId: h.id,
            workerName: h.workerName || "?",
            workerRole: h.workerRole || "floor",
            startDate: h.startDate,
            endDate: h.endDate,
            recommendation: "deny",
            reason: `Rendrait ${unfillable.length} cr\u00e9neau${unfillable.length > 1 ? "x" : ""} impossible${unfillable.length > 1 ? "s" : ""} : ${slotLabels.join(", ")}`,
            unfillableSlots: unfillable,
            balanceContext,
          });
        }
      } catch {
        results.push({
          holidayId: h.id,
          workerName: h.workerName || "?",
          workerRole: h.workerRole || "floor",
          startDate: h.startDate,
          endDate: h.endDate,
          recommendation: "approve",
          reason: "Analyse solveur indisponible",
          balanceContext,
        });
        approvedSoFar.push(toRefAbsence(h));
      }
    }

    clusters.push({
      holidays: results,
      approveCount: results.filter(r => r.recommendation === "approve").length,
      denyCount: results.filter(r => r.recommendation === "deny").length,
    });
  }

  return clusters;
}

function daysBetweenDates(a: string, b: string): number {
  const ad = new Date(a + "T12:00:00").getTime();
  const bd = new Date(b + "T12:00:00").getTime();
  return Math.max(1, Math.round((bd - ad) / (24 * 3600 * 1000)) + 1);
}

/** Expand each restaurant closure into its covered Monday-anchored weeks.
 *  All-or-nothing model: every day inside [startDate, endDate] counts as
 *  imposed leave for every active worker (fermeture annuelle pattern).
 *  Partial-week closures still consume the overlapping business days. */
function closureWeeks(restaurantId: string, periodEnd: string): Array<{ weekStart: string; weekEnd: string; days: number; label: string }> {
  const today = fmtDate(new Date());
  const rows = db.select()
    .from(restaurantClosures)
    .where(eq(restaurantClosures.restaurantId, restaurantId))
    .all();

  const out: Array<{ weekStart: string; weekEnd: string; days: number; label: string }> = [];
  for (const c of rows) {
    if (c.schedule) continue; // reduced-schedule closures aren't full closures — treat as normal
    if (c.endDate < today) continue; // skip past closures
    if (c.startDate > periodEnd) continue; // a future-period closure can't clear CP expiring this May 31

    // Iterate Mondays touched by this closure's range
    const start = new Date(c.startDate + "T12:00:00");
    const effectiveEnd = c.endDate < periodEnd ? c.endDate : periodEnd;
    const end = new Date(effectiveEnd + "T12:00:00");
    const firstMon = new Date(start);
    firstMon.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    for (let m = new Date(firstMon); m <= end; m.setDate(m.getDate() + 7)) {
      const monday = fmtDate(m);
      const sunday = (() => { const d = new Date(m); d.setDate(d.getDate() + 6); return fmtDate(d); })();
      const overlapStart = c.startDate > monday ? c.startDate : monday;
      const overlapEnd = effectiveEnd < sunday ? effectiveEnd : sunday;
      const days = Math.min(5, daysBetweenDates(overlapStart, overlapEnd)); // cap at 5 business days
      if (days <= 0) continue;
      out.push({
        weekStart: monday,
        weekEnd: sunday,
        days,
        label: c.reason || "Fermeture",
      });
    }
  }
  return out;
}

/**
 * Closure-aware year-spread of CP across the payroll period (1 juin → 31 mai).
 *
 * Two passes:
 *   1. Pre-allocate full-closure weeks — every active worker loses N days
 *      (the overlap of the closure with business days in that week) up to
 *      their remaining balance.
 *   2. Greedy spread: for each worker (urgency-sorted), place 5-day weeks
 *      across the remaining horizon under two constraints:
 *         - anti-clumping: max MAX_PER_ROLE_PER_WEEK same-role absences/week
 *         - coverage: the solver still fills every target after the added
 *           absence (solver is the single source of truth, NOT calendar
 *           heuristics like school holidays).
 *
 * Returns a flat list of suggestions; each carries `source: "closure" | "solver"`
 * so the UI can render them differently.
 */
async function computeLeaveSpread(
  restaurantId: string,
  balances: LeaveBalance[],
): Promise<WorkerLeaveSuggestion[]> {
  if (balances.length === 0) return [];

  // Mutable balance map — pre-allocation and spread both draw from here.
  const remainingByWorker = new Map<string, number>();
  for (const b of balances) remainingByWorker.set(b.workerId, b.remainingDays);

  const out: WorkerLeaveSuggestion[] = [];
  const today = new Date();
  const periodEndYear = today.getMonth() >= 5 ? today.getFullYear() + 1 : today.getFullYear();
  const periodEnd = new Date(`${periodEndYear}-05-31T23:59:59`);
  const periodEndStr = fmtDate(periodEnd);

  // ── Pass 1 — closure pre-allocation (all-or-nothing) ──
  const closures = closureWeeks(restaurantId, periodEndStr);
  for (const cw of closures) {
    for (const b of balances) {
      const remaining = remainingByWorker.get(b.workerId) ?? 0;
      if (remaining <= 0) continue;
      const consumed = Math.min(remaining, cw.days);
      remainingByWorker.set(b.workerId, remaining - consumed);
      out.push({
        workerId: b.workerId,
        workerName: b.workerName,
        role: b.role,
        remainingDays: remaining,
        expiringSoon: b.expiringSoon,
        weekStart: cw.weekStart,
        weekEnd: cw.weekEnd,
        suggestedDays: consumed,
        reason: cw.label,
        source: "closure",
      });
    }
  }

  // Solver-backed "send someone now" suggestions are expensive because each
  // candidate requires a full weekly coverage solve. When no balance is
  // expiring, the page can still show CP balances/advice without burning
  // seconds proving optional leave opportunities on load.
  if (!balances.some(b => b.expiringSoon)) return out;

  // ── Pass 2 — solver-backed spread across full period horizon ──
  const eligible = balances
    .filter(b => (remainingByWorker.get(b.workerId) ?? 0) >= 5)
    .sort((a, b) => {
      if (a.expiringSoon !== b.expiringSoon) return a.expiringSoon ? -1 : 1;
      return (remainingByWorker.get(b.workerId) ?? 0) - (remainingByWorker.get(a.workerId) ?? 0);
    });
  if (eligible.length === 0) return out;

  const firstMonday = new Date(today);
  firstMonday.setDate(firstMonday.getDate() - ((firstMonday.getDay() + 6) % 7) + 7);
  const horizonWeeks: string[] = [];
  for (let i = 0; ; i++) {
    const d = new Date(firstMonday);
    d.setDate(d.getDate() + i * 7);
    if (d > periodEnd) break;
    horizonWeeks.push(fmtDate(d));
    if (horizonWeeks.length > 60) break; // safety cap
  }
  if (horizonWeeks.length === 0) return out;

  const MAX_PER_ROLE_PER_WEEK = 2;
  // Seed week-absences from closure pass so anti-clumping respects them.
  const weekAbsences = new Map<string, Array<{ workerId: string; role: string; startDate: string; endDate: string }>>();
  for (const s of out) {
    const list = weekAbsences.get(s.weekStart) ?? [];
    list.push({ workerId: s.workerId, role: s.role, startDate: s.weekStart, endDate: s.weekEnd });
    weekAbsences.set(s.weekStart, list);
  }

  const weekRangeOf = (monday: string) => {
    const dates = weekDates(monday);
    return { start: dates[0], end: dates[6] };
  };

  for (const w of eligible) {
    let remaining = remainingByWorker.get(w.workerId) ?? 0;
    for (const monday of horizonWeeks) {
      if (remaining < 5) break;
      const existing = weekAbsences.get(monday) ?? [];
      if (existing.some(a => a.workerId === w.workerId)) continue; // already allocated this week (e.g. by closure)
      const sameRole = existing.filter(a => a.role === w.role).length;
      if (sameRole >= MAX_PER_ROLE_PER_WEEK) continue;

      const { start, end } = weekRangeOf(monday);
      const trial = [
        ...existing.map(a => ({ workerId: a.workerId, startDate: a.startDate, endDate: a.endDate })),
        { workerId: w.workerId, startDate: start, endDate: end },
      ];

      try {
        const plan = await generatePlan(restaurantId, monday, undefined, {
          holidayFilter: ["approved"],
          extraAbsences: trial,
        });

        const weekNum = isoWeekNum(monday);
        const weekYear = isoWeekYear(monday);
        const [assignment] = db.select({ profileId: staffingSchedule.profileId })
          .from(staffingSchedule)
          .where(and(
            eq(staffingSchedule.restaurantId, restaurantId),
            eq(staffingSchedule.year, weekYear),
            eq(staffingSchedule.week, weekNum),
          )).limit(1).all();
        let profileId = assignment?.profileId;
        if (!profileId) {
          const [first] = db.select({ id: staffingProfiles.id })
            .from(staffingProfiles)
            .where(eq(staffingProfiles.restaurantId, restaurantId))
            .orderBy(staffingProfiles.sortOrder)
            .limit(1).all();
          profileId = first?.id;
        }
        if (!profileId) continue;

        const targets = db.select().from(staffingTargets)
          .where(and(eq(staffingTargets.restaurantId, restaurantId), eq(staffingTargets.profileId, profileId))).all();

        const fills = new Map<string, Set<string>>();
        for (const s of plan.services) {
          const dow = isoDayOfWeek(s.date);
          const key = `${dow}_${s.role}_${s.zone}`;
          if (!fills.has(key)) fills.set(key, new Set());
          fills.get(key)!.add(s.workerId);
        }

        const allCovered = targets.every(t => {
          if (t.count === 0) return true;
          const key = `${t.dayOfWeek}_${t.role}_${t.zone}`;
          return (fills.get(key)?.size ?? 0) >= t.count;
        });

        if (allCovered) {
          existing.push({ workerId: w.workerId, role: w.role, startDate: start, endDate: end });
          weekAbsences.set(monday, existing);
          remaining -= 5;
          remainingByWorker.set(w.workerId, remaining);
          out.push({
            workerId: w.workerId,
            workerName: w.workerName,
            role: w.role,
            remainingDays: remaining + 5, // balance before this allocation
            expiringSoon: w.expiringSoon,
            weekStart: start,
            weekEnd: end,
            suggestedDays: 5,
            reason: w.expiringSoon
              ? `${remaining + 5}j de solde critique`
              : `${remaining + 5}j restants`,
            source: "solver",
          });
        }
      } catch {
        continue;
      }
    }
  }

  return out;
}

/** Aggregate everything the /holidays page needs in a single call. */
export async function computeLeaveIntelligence(restaurantId: string, profileId?: string): Promise<LeaveIntelligence> {
  const balances = computeLeaveBalances(restaurantId);
  const compliance = computeLeaveCompliance(balances);
  const urgency = computeLeaveUrgency(balances);

  // Enrich staffing analysis with OT capacity so the advice surplus is accurate.
  const analysis = analyzeStaffing(restaurantId, profileId);
  const otRow = db.select({
    overtimeMode: restaurants.overtimeMode,
    overtimeWeeklyCap: restaurants.overtimeWeeklyCap,
  }).from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1).all();
  const otMode = otRow[0]?.overtimeMode ?? "flexible";
  const otWeeklyCap = otRow[0]?.overtimeWeeklyCap ?? 48;
  for (const cap of analysis.capacity) {
    const roleWorkers = analysis.workerLoads.filter(w => w.role === cap.role);
    cap.otCapacityHours = Math.round(computeOtCapacity(roleWorkers, otMode, otWeeklyCap));
    cap.effectiveCapacityHours = cap.totalContractHours + cap.otCapacityHours;
  }
  const advice = computeHolidayAdvice(restaurantId, analysis);
  advice.workerSuggestions = await computeLeaveSpread(restaurantId, balances);

  const pendingClusters = await computePendingClusters(restaurantId, balances);

  return {
    generatedAt: new Date().toISOString(),
    balances,
    advice,
    pendingClusters,
    compliance,
    urgency,
  };
}
