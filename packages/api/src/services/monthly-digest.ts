/**
 * Monthly digest — end-of-month recap for the admin + extra recipients.
 * Aggregates hours / coverage / revenue / leave state for the month just ended.
 *
 * Called by the cron endpoint; returns a structured payload that email.ts
 * renders into HTML.
 */

import { db } from "../db/connection.js";
import {
  restaurants,
  users,
  dailyRevenue,
  services,
  replacementRequests,
  timeClocks,
} from "../db/schema.js";
import { eq, and, gte, lte, ne, isNotNull, inArray, between } from "drizzle-orm";
import { computeLeaveBalances } from "./holiday-advice.js";
import { computePayroll, type PayrollExport } from "./payroll.js";
import { computeExpiringDocsReport } from "./onboarding-checklist.js";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";

export type MonthlyDigest = {
  restaurantId: string;
  restaurantName: string;
  /** YYYY-MM of the month being recapped. */
  month: string;
  /** "mars 2026" */
  monthLabel: string;
  hours: {
    total: number;
    kitchen: number;
    floor: number;
  };
  revenue: {
    total: number;
    avgDaily: number;
    daysWithData: number;
  };
  coverage: {
    scheduledServices: number;
    scheduledHours: number;
  };
  leave: {
    expiringSoonCount: number;
    expiringSoonWorkers: { name: string; days: number }[];
    totalRemainingDays: number;
    /** Days of paid leave actually taken in the month (sum across team). */
    daysTakenInMonth: number;
    /** Days of sick leave taken in the month. */
    sickDaysTakenInMonth: number;
  };
  /** Per-employee hours for the month — sorted by totalHours desc. */
  workers: Array<{
    name: string;
    role: "kitchen" | "floor";
    totalHours: number;
    overtimeHours: number;
    daysWorked: number;
    holidayDays: number;
    sickDays: number;
  }>;
  overtime: {
    totalHours: number;
    ot110: number;
    ot120: number;
    ot150: number;
  };
  /** Worker documents that have expired or will expire in the next 30 days. */
  docs: {
    expiredCount: number;
    expiringSoonCount: number;
    /** Top items sorted by daysUntilExpiry asc — already-expired first. */
    topItems: Array<{ workerName: string; label: string; daysUntilExpiry: number; expired: boolean }>;
  };
  /** CDD/saisonnier contracts ending in the month FOLLOWING the recap month — so
   *  the owner has runway to renew or hire before the worker's last shift. */
  contracts: {
    endingNextMonth: Array<{ workerName: string; type: "CDD" | "saisonnier"; endDate: string }>;
  };
  /** Replacement-request churn for the month (created_at within the period). */
  replacements: {
    total: number;
    accepted: number;
    rejected: number;
    expired: number;
    cancelled: number;
    /** Still open at month end (awaiting_admin_decision or awaiting_worker_reply). */
    pending: number;
  };
  /** Service-cancellation rate. */
  cancellations: {
    count: number;
    totalServices: number;
    pct: number; // 0-100, rounded
  };
  /** Lateness & early-leave aggregated from time clocks vs scheduled services. */
  lateness: {
    /** Number of time-clock records with positive lateMin or earlyLeaveMin. */
    incidents: number;
    totalLateMinutes: number;
    totalEarlyLeaveMinutes: number;
    /** Top offenders, sorted by totalLateMinutes desc. */
    topWorkers: Array<{
      workerName: string;
      incidents: number;
      totalLateMinutes: number;
      totalEarlyLeaveMinutes: number;
    }>;
  };
  /** Full payroll export — used to attach the CSV to the email. */
  payroll: PayrollExport;
  includeSilaeInMonthlyDigest: boolean;
  silaeCodes: Record<string, string>;
};

const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

function monthLabelFr(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_FR[m - 1]} ${y}`;
}

/** Last completed month in YYYY-MM (i.e. if today is 2026-05-03, returns 2026-04). */
export function lastCompletedMonth(today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Revenue totals in euros (amount is stored in cents). */
function revenueTotals(restaurantId: string, start: string, end: string): { total: number; days: number } {
  const rows = db.select({ amount: dailyRevenue.amount })
    .from(dailyRevenue)
    .where(and(
      eq(dailyRevenue.restaurantId, restaurantId),
      gte(dailyRevenue.date, start),
      lte(dailyRevenue.date, end),
    )).all();
  const totalCents = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  return { total: totalCents / 100, days: rows.length };
}

function parseHM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h * 60) + (m ?? 0);
}

/** Count of scheduled services and their total hours for the month. */
function scheduledStats(restaurantId: string, start: string, end: string): { scheduledServices: number; scheduledHours: number } {
  const rows = db.select({ startTime: services.startTime, endTime: services.endTime, status: services.status })
    .from(services)
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, start),
      lte(services.date, end),
    )).all();
  const active = rows.filter(r => r.status !== "cancelled");
  const totalMin = active.reduce((s, r) => s + Math.max(0, parseHM(r.endTime) - parseHM(r.startTime)), 0);
  return {
    scheduledServices: active.length,
    scheduledHours: Math.round(totalMin / 60 * 10) / 10,
  };
}

/** Cancellation rate over the month — count and percentage of all scheduled services. */
function cancellationStats(restaurantId: string, start: string, end: string) {
  const rows = db.select({ status: services.status })
    .from(services)
    .where(and(
      eq(services.restaurantId, restaurantId),
      gte(services.date, start),
      lte(services.date, end),
    )).all();
  const totalServices = rows.length;
  const count = rows.filter(r => r.status === "cancelled").length;
  return {
    count,
    totalServices,
    pct: totalServices > 0 ? Math.round((count / totalServices) * 100) : 0,
  };
}

/** Replacement-request churn — counts requests CREATED in the month. */
function replacementStats(restaurantId: string, start: string, end: string) {
  // created_at is a datetime; compare by date prefix.
  const rows = db.select({ status: replacementRequests.status, createdAt: replacementRequests.createdAt })
    .from(replacementRequests)
    .where(eq(replacementRequests.restaurantId, restaurantId))
    .all()
    .filter(r => {
      const d = (r.createdAt ?? "").slice(0, 10);
      return d >= start && d <= end;
    });
  const by = (s: string) => rows.filter(r => r.status === s).length;
  return {
    total: rows.length,
    accepted: by("accepted"),
    rejected: by("rejected"),
    expired: by("expired"),
    cancelled: by("cancelled"),
    pending: by("awaiting_admin_decision") + by("awaiting_worker_reply"),
  };
}

/** Lateness aggregation from time_clocks ⨯ services for the month.
 *  Mirrors the logic in routes/timeclock.ts GET /timeclock/lateness. */
function latenessStats(restaurantId: string, start: string, end: string) {
  const rows = db.select({
      userId: timeClocks.userId,
      userName: users.name,
      tapIn: timeClocks.tapIn,
      tapOut: timeClocks.tapOut,
      scheduledStart: services.startTime,
      scheduledEnd: services.endTime,
    })
    .from(timeClocks)
    .leftJoin(services, eq(services.id, timeClocks.serviceId))
    .leftJoin(users, eq(users.id, timeClocks.userId))
    .where(and(
      eq(timeClocks.restaurantId, restaurantId),
      between(timeClocks.date, start, end),
    ))
    .all();

  const byWorker = new Map<string, { workerName: string; incidents: number; totalLateMinutes: number; totalEarlyLeaveMinutes: number }>();
  let incidents = 0;
  let totalLate = 0;
  let totalEarly = 0;

  for (const r of rows) {
    if (!r.scheduledStart) continue;
    const tapIn = new Date(r.tapIn);
    const [sh, sm] = r.scheduledStart.split(":").map(Number);
    const schedStart = new Date(tapIn);
    schedStart.setHours(sh, sm, 0, 0);
    const lateMin = Math.max(0, Math.round((tapIn.getTime() - schedStart.getTime()) / 60000));

    let earlyMin = 0;
    if (r.tapOut && r.scheduledEnd) {
      const tapOut = new Date(r.tapOut);
      const [eh, em] = r.scheduledEnd.split(":").map(Number);
      const schedEnd = new Date(tapOut);
      schedEnd.setHours(eh, em, 0, 0);
      earlyMin = Math.max(0, Math.round((schedEnd.getTime() - tapOut.getTime()) / 60000));
    }
    if (lateMin === 0 && earlyMin === 0) continue;
    incidents++;
    totalLate += lateMin;
    totalEarly += earlyMin;
    const cur = byWorker.get(r.userId) ?? { workerName: r.userName ?? "—", incidents: 0, totalLateMinutes: 0, totalEarlyLeaveMinutes: 0 };
    cur.incidents++;
    cur.totalLateMinutes += lateMin;
    cur.totalEarlyLeaveMinutes += earlyMin;
    byWorker.set(r.userId, cur);
  }

  const topWorkers = [...byWorker.values()]
    .sort((a, b) => (b.totalLateMinutes + b.totalEarlyLeaveMinutes) - (a.totalLateMinutes + a.totalEarlyLeaveMinutes))
    .slice(0, 5);

  return { incidents, totalLateMinutes: totalLate, totalEarlyLeaveMinutes: totalEarly, topWorkers };
}

/** Active CDD/saisonnier contracts ending within a date range. */
export function contractsEndingInRange(restaurantId: string, start: string, end: string) {
  const memberIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"] });
  if (memberIds.length === 0) return [];

  const rows = db.select({
      name: users.name,
      contractType: users.contractType,
      contractEndDate: users.contractEndDate,
      active: users.active,
    })
    .from(users)
    .where(and(
      inArray(users.id, memberIds),
      ne(users.role, "admin"),
      eq(users.active, true),
      isNotNull(users.contractEndDate),
      inArray(users.contractType, ["CDD", "saisonnier"]),
    ))
    .all()
    .filter(r => r.contractEndDate! >= start && r.contractEndDate! <= end);
  return rows
    .sort((a, b) => (a.contractEndDate ?? "").localeCompare(b.contractEndDate ?? ""))
    .map(r => ({ workerName: r.name, type: r.contractType as "CDD" | "saisonnier", endDate: r.contractEndDate! }));
}

export function computeMonthlyDigest(restaurantId: string, month: string): MonthlyDigest | null {
  const r = db.select().from(restaurants).where(eq(restaurants.id, restaurantId)).get();
  if (!r) return null;

  const { start, end } = monthRange(month);

  const rev = revenueTotals(restaurantId, start, end);
  const cov = scheduledStats(restaurantId, start, end);
  const cancellations = cancellationStats(restaurantId, start, end);
  const replacements = replacementStats(restaurantId, start, end);
  const lateness = latenessStats(restaurantId, start, end);

  // Contracts: warn about NEXT month's endings — gives the owner ≥30 days to renew/hire.
  const [yy, mm] = month.split("-").map(Number);
  const nextMonth = `${mm === 12 ? yy + 1 : yy}-${String(mm === 12 ? 1 : mm + 1).padStart(2, "0")}`;
  const { start: nextStart, end: nextEnd } = monthRange(nextMonth);
  const contracts = { endingNextMonth: contractsEndingInRange(restaurantId, nextStart, nextEnd) };

  // Documents — `computeExpiringDocsReport` looks at expiresAt globally; trim to top items.
  const allDocAlerts = computeExpiringDocsReport(restaurantId);
  const docs = {
    expiredCount: allDocAlerts.filter(a => a.expired).length,
    expiringSoonCount: allDocAlerts.filter(a => !a.expired).length,
    topItems: allDocAlerts.slice(0, 8).map(a => ({
      workerName: a.workerName,
      label: a.label,
      daysUntilExpiry: a.daysUntilExpiry,
      expired: a.expired,
    })),
  };

  const balances = computeLeaveBalances(restaurantId);
  const expiring = balances.filter(b => b.expiringSoon);
  const totalRemaining = balances.reduce((s, b) => s + b.remainingDays, 0);

  const payroll = computePayroll(restaurantId, month);

  // Hours derived from payroll (services-based, same source as the per-employee table).
  const sumHours = (role?: "kitchen" | "floor") =>
    payroll.workers
      .filter(w => !role || w.role === role)
      .reduce((s, w) => s + w.totalHours, 0);
  const h = {
    total: Math.round(sumHours() * 10) / 10,
    kitchen: Math.round(sumHours("kitchen") * 10) / 10,
    floor: Math.round(sumHours("floor") * 10) / 10,
  };
  const workers = payroll.workers
    .filter(w => w.totalHours > 0 || w.holidayDays > 0 || w.sickDays > 0)
    .sort((a, b) => b.totalHours - a.totalHours)
    .map(w => ({
      name: w.name,
      role: w.role,
      totalHours: w.totalHours,
      overtimeHours: w.overtimeHours,
      daysWorked: w.daysWorked,
      holidayDays: w.holidayDays,
      sickDays: w.sickDays,
    }));

  return {
    restaurantId,
    restaurantName: r.name,
    month,
    monthLabel: monthLabelFr(month),
    hours: {
      total: h.total,
      kitchen: h.kitchen,
      floor: h.floor,
    },
    revenue: {
      total: Math.round(rev.total),
      avgDaily: rev.days > 0 ? Math.round(rev.total / rev.days) : 0,
      daysWithData: rev.days,
    },
    coverage: cov,
    leave: {
      expiringSoonCount: expiring.length,
      expiringSoonWorkers: expiring.slice(0, 10).map(b => ({ name: b.workerName, days: b.remainingDays })),
      totalRemainingDays: Math.round(totalRemaining),
      daysTakenInMonth: payroll.totals.holidayDays,
      sickDaysTakenInMonth: payroll.totals.sickDays,
    },
    workers,
    overtime: {
      totalHours: payroll.totals.overtimeHours,
      ot110: payroll.totals.ot110,
      ot120: payroll.totals.ot120,
      ot150: payroll.totals.ot150,
    },
    docs,
    contracts,
    replacements,
    cancellations,
    lateness,
    payroll,
    includeSilaeInMonthlyDigest: !!r.includeSilaeInMonthlyDigest,
    silaeCodes: JSON.parse(r.silaeCodes || "{}"),
  };
}
