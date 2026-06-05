import { db, rawDb } from "../db/connection.js";
import { services, users, holidayRequests, restaurants, workerShareAuthorizations } from "../db/schema.js";
import { eq, and, gte, lte, ne, inArray } from "drizzle-orm";
import { isoWeekNum as isoWeekNumUtil } from "../utils/scheduling.js";
import { listRestaurantMemberUserIds } from "./restaurant-context.js";

// ── French payroll constants ──
const HCR_OT_THRESHOLD = 39; // Convention HCR: 39h/week
const MONTHLY_BASE_HOURS = 151.67; // 35h × 52 / 12

function tableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

// ── Types ──

export type PayrollWeek = {
  weekNum: number; // ISO week number
  from: string; // Monday YYYY-MM-DD
  to: string; // Sunday YYYY-MM-DD
  totalHours: number; // full week hours (for OT calculation)
  monthHours: number; // hours that fall within the pay month
  overtime: number;
  breakdown: { rate110: number; rate120: number; rate150: number };
  straddling: boolean; // true if week spans month boundary
};

export type PayrollAnalyticSection = {
  restaurantId: string;
  restaurantName: string;
  serviceCount: number;
  daysWorked: number;
  totalHours: number;
  baseHours: number;
  ot110: number;
  ot120: number;
  ot150: number;
};

export type PayrollAbsence = {
  type: "holiday" | "sick";
  startDate: string; // YYYY-MM-DD, clamped to payroll month
  endDate: string; // YYYY-MM-DD, clamped to payroll month
  days: number;
};

export type PayrollWorker = {
  workerId: string;
  matricule: string | null;
  name: string;
  role: "kitchen" | "floor";
  // Hours
  baseHours: number; // heures normales (total month hours minus OT)
  totalHours: number; // all hours in the month
  overtimeHours: number; // sum of OT allocated to this month
  ot110: number;
  ot120: number;
  ot150: number;
  // Counts
  daysWorked: number;
  servicesWorked: number;
  // Absences
  holidayDays: number; // congés payés (approved, non-medical)
  sickDays: number; // arrêt maladie (approved, medical)
  absences: PayrollAbsence[];
  // Meals (avantage en nature)
  mealDays: number; // days with at least one service (for avantage en nature repas)
  analytics: PayrollAnalyticSection[];
  // Weekly detail
  weeks: PayrollWeek[];
};

export type PayrollExport = {
  month: string; // YYYY-MM
  restaurantName: string;
  generatedAt: string; // ISO
  baseReference: number; // 151.67h
  otThreshold: number; // 39h
  workers: PayrollWorker[];
  totals: {
    baseHours: number;
    totalHours: number;
    overtimeHours: number;
    ot110: number;
    ot120: number;
    ot150: number;
    daysWorked: number;
    holidayDays: number;
    sickDays: number;
  };
};

// ── Helpers ──

const r2 = (n: number) => Math.round(n * 100) / 100;

function serviceMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let diff = eh * 60 + em - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60; // overnight
  return diff;
}

/** Get ISO week number */
const isoWeekNum = isoWeekNumUtil;

/** Format date as YYYY-MM-DD without timezone service */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Get all civil weeks (Mon-Sun) that overlap with a month */
function getMonthWeeks(year: number, month: number): Array<{ from: string; to: string }> {
  // Use noon to avoid timezone edge cases
  const firstDay = new Date(year, month, 1, 12);
  const lastDay = new Date(year, month + 1, 0, 12);

  // Find the Monday on or before the 1st
  const firstMonday = new Date(firstDay);
  const dow = firstMonday.getDay();
  firstMonday.setDate(firstMonday.getDate() - ((dow + 6) % 7));

  const weeks: Array<{ from: string; to: string }> = [];
  for (let d = new Date(firstMonday); d <= lastDay; d.setDate(d.getDate() + 7)) {
    const wFrom = fmtDate(d);
    const wSun = new Date(d);
    wSun.setDate(d.getDate() + 6);
    weeks.push({ from: wFrom, to: fmtDate(wSun) });
  }
  return weeks;
}

/** Count business days in a date range that fall within a month */
function countDaysInRange(startDate: string, endDate: string, monthFrom: string, monthTo: string): number {
  let count = 0;
  const clampStart = startDate > monthFrom ? startDate : monthFrom;
  const clampEnd = endDate < monthTo ? endDate : monthTo;
  const start = new Date(clampStart + "T12:00:00");
  const end = new Date(clampEnd + "T12:00:00");

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0) count++; // exclude Sundays
  }
  return count;
}

function clampDateRange(startDate: string, endDate: string, monthFrom: string, monthTo: string): { startDate: string; endDate: string } {
  return {
    startDate: startDate > monthFrom ? startDate : monthFrom,
    endDate: endDate < monthTo ? endDate : monthTo,
  };
}

function formatSilaeDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

// ── Main export function ──

export function computePayroll(restaurantId: string, monthParam: string): PayrollExport {
  const [yearStr, monthStr] = monthParam.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr) - 1; // 0-indexed

  const firstDay = new Date(year, month, 1, 12);
  const lastDay = new Date(year, month + 1, 0, 12);
  const monthFrom = fmtDate(firstDay);
  const monthTo = fmtDate(lastDay);

  // Restaurant info
  const [restaurant] = db.select({ id: restaurants.id, name: restaurants.name, ownerId: restaurants.ownerId })
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId))
    .limit(1)
    .all();

  // Get all weeks overlapping this month
  const weeks = getMonthWeeks(year, month);
  const spanFrom = weeks[0].from;
  const spanTo = weeks[weeks.length - 1].to;

  // Fetch workers (non-admin)
  const workerIds = listRestaurantMemberUserIds(restaurantId, { roles: ["manager", "kitchen", "floor"], includeInactiveUsers: true });
  const workerList = workerIds.length > 0
    ? db.select({
      id: users.id,
      name: users.name,
      role: users.role,
      matricule: users.matricule,
    })
      .from(users)
      .where(and(inArray(users.id, workerIds), ne(users.role, "admin")))
      .all()
    : [];

  const sharedTargetIds = workerIds.length > 0 && tableExists("worker_share_authorizations")
    ? db.select({ restaurantId: workerShareAuthorizations.targetRestaurantId })
      .from(workerShareAuthorizations)
      .where(and(
        eq(workerShareAuthorizations.sourceRestaurantId, restaurantId),
        eq(workerShareAuthorizations.ownerId, restaurant?.ownerId ?? restaurantId),
        eq(workerShareAuthorizations.status, "accepted"),
        inArray(workerShareAuthorizations.userId, workerIds),
      ))
      .all()
      .filter((row) => row.restaurantId !== restaurantId)
      .map((row) => row.restaurantId)
    : [];
  const payrollScopeRestaurantIds = Array.from(new Set([restaurantId, ...sharedTargetIds]));
  const restaurantRows = payrollScopeRestaurantIds.length > 0
    ? db.select({ id: restaurants.id, name: restaurants.name })
      .from(restaurants)
      .where(inArray(restaurants.id, payrollScopeRestaurantIds))
      .all()
    : [];
  const restaurantNameById = new Map(restaurantRows.map((row) => [row.id, row.name]));

  // Fetch services in the payroll scope. Shared target services stay attached to
  // the restaurant where they were actually worked for analytical accounting.
  const allServices = workerIds.length > 0
    ? db.select({
      restaurantId: services.restaurantId,
      workerId: services.workerId,
      date: services.date,
      startTime: services.startTime,
      endTime: services.endTime,
      role: services.role,
    })
      .from(services)
      .where(and(
        inArray(services.restaurantId, payrollScopeRestaurantIds),
        inArray(services.workerId, workerIds),
        gte(services.date, spanFrom),
        lte(services.date, spanTo),
        ne(services.status, "cancelled"),
      ))
      .orderBy(services.date, services.startTime)
      .all()
    : [];

  // Fetch approved holidays overlapping with this month
  const holidays = db.select({
    workerId: holidayRequests.workerId,
    startDate: holidayRequests.startDate,
    endDate: holidayRequests.endDate,
    medical: holidayRequests.medical,
  })
    .from(holidayRequests)
    .where(and(
      eq(holidayRequests.restaurantId, restaurantId),
      eq(holidayRequests.status, "approved"),
      lte(holidayRequests.startDate, monthTo),
      gte(holidayRequests.endDate, monthFrom),
    ))
    .all();

  // Build worker payroll data
  const payrollWorkers: PayrollWorker[] = [];

  for (const worker of workerList) {
    const workerServices = allServices.filter(s => s.workerId === worker.id);
    if (workerServices.length === 0) {
      // Check if worker has holidays this month — still include them
      const workerHolidays = holidays.filter(h => h.workerId === worker.id);
      if (workerHolidays.length === 0) continue;
    }

    const weekDetails: PayrollWeek[] = [];
    let monthTotalMinutes = 0;
    let monthOT = 0;
    let monthOT110 = 0;
    let monthOT120 = 0;
    let monthOT150 = 0;

    // Track unique days worked in the month
    const daysWorkedSet = new Set<string>();
    const analyticMap = new Map<string, { restaurantId: string; restaurantName: string; services: number; minutes: number; days: Set<string> }>();

    for (const week of weeks) {
      const weekServices = workerServices.filter(s => s.date >= week.from && s.date <= week.to);
      if (weekServices.length === 0) continue;

      // Full week hours (for OT calculation — French law requires full week)
      let weekTotalMinutes = 0;
      let monthPortionMinutes = 0;

      for (const s of weekServices) {
        const mins = serviceMinutes(s.startTime, s.endTime);
        weekTotalMinutes += mins;

        // Only count hours for days within the pay month
        if (s.date >= monthFrom && s.date <= monthTo) {
          monthPortionMinutes += mins;
          daysWorkedSet.add(s.date);
          const analytic = analyticMap.get(s.restaurantId) ?? {
            restaurantId: s.restaurantId,
            restaurantName: restaurantNameById.get(s.restaurantId) ?? s.restaurantId,
            services: 0,
            minutes: 0,
            days: new Set<string>(),
          };
          analytic.services += 1;
          analytic.minutes += mins;
          analytic.days.add(s.date);
          analyticMap.set(s.restaurantId, analytic);
        }
      }

      const weekTotalHours = r2(weekTotalMinutes / 60);
      const monthPortionHours = r2(monthPortionMinutes / 60);

      // OT computed on full week (labor law is weekly)
      const weekOT = Math.max(0, weekTotalHours - HCR_OT_THRESHOLD);
      const ot110 = Math.min(weekOT, 4); // 39-43h
      const ot120 = Math.min(Math.max(weekOT - 4, 0), 4); // 43-47h
      const ot150 = Math.max(weekOT - 8, 0); // 47h+

      // For straddling weeks: assign OT to the month where Sunday falls
      // This is the standard French payroll practice
      const sunday = week.to;
      const sundayInMonth = sunday >= monthFrom && sunday <= monthTo;
      const straddling = week.from < monthFrom || week.to > monthTo;

      // OT goes to this month only if Sunday is in this month
      const assignedOT = sundayInMonth ? weekOT : 0;
      const assignedOT110 = sundayInMonth ? ot110 : 0;
      const assignedOT120 = sundayInMonth ? ot120 : 0;
      const assignedOT150 = sundayInMonth ? ot150 : 0;

      weekDetails.push({
        weekNum: isoWeekNum(week.from),
        from: week.from,
        to: week.to,
        totalHours: weekTotalHours,
        monthHours: monthPortionHours,
        overtime: r2(assignedOT),
        breakdown: {
          rate110: r2(assignedOT110),
          rate120: r2(assignedOT120),
          rate150: r2(assignedOT150),
        },
        straddling,
      });

      monthTotalMinutes += monthPortionMinutes;
      monthOT += assignedOT;
      monthOT110 += assignedOT110;
      monthOT120 += assignedOT120;
      monthOT150 += assignedOT150;
    }

    const totalHours = r2(monthTotalMinutes / 60);
    const overtimeHours = r2(monthOT);
    const baseHours = r2(Math.max(0, totalHours - overtimeHours));
    const allocate = (amount: number, sectionHours: number) =>
      totalHours > 0 ? r2(amount * (sectionHours / totalHours)) : 0;
    const analytics = [...analyticMap.values()]
      .map((section) => {
        const sectionHours = r2(section.minutes / 60);
        return {
          restaurantId: section.restaurantId,
          restaurantName: section.restaurantName,
          serviceCount: section.services,
          daysWorked: section.days.size,
          totalHours: sectionHours,
          baseHours: allocate(baseHours, sectionHours),
          ot110: allocate(monthOT110, sectionHours),
          ot120: allocate(monthOT120, sectionHours),
          ot150: allocate(monthOT150, sectionHours),
        };
      })
      .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName, "fr", { sensitivity: "base" }));

    // Holiday / sick days in this month
    const workerHolidays = holidays.filter(h => h.workerId === worker.id);
    let holidayDays = 0;
    let sickDays = 0;
    const absences: PayrollAbsence[] = [];
    for (const h of workerHolidays) {
      const days = countDaysInRange(h.startDate, h.endDate, monthFrom, monthTo);
      if (days === 0) continue;
      const range = clampDateRange(h.startDate, h.endDate, monthFrom, monthTo);
      if (h.medical) {
        sickDays += days;
        absences.push({ type: "sick", ...range, days });
      } else {
        holidayDays += days;
        absences.push({ type: "holiday", ...range, days });
      }
    }

    payrollWorkers.push({
      workerId: worker.id,
      matricule: worker.matricule,
      name: worker.name,
      role: worker.role as "kitchen" | "floor",
      baseHours,
      totalHours,
      overtimeHours,
      ot110: r2(monthOT110),
      ot120: r2(monthOT120),
      ot150: r2(monthOT150),
      daysWorked: daysWorkedSet.size,
      servicesWorked: workerServices.filter(s => s.date >= monthFrom && s.date <= monthTo).length,
      holidayDays,
      sickDays,
      absences,
      mealDays: daysWorkedSet.size, // 1 repas per worked day
      analytics,
      weeks: weekDetails,
    });
  }

  // Sort by name
  payrollWorkers.sort((a, b) => a.name.localeCompare(b.name));

  const sum = (fn: (w: PayrollWorker) => number) =>
    r2(payrollWorkers.reduce((s, w) => s + fn(w), 0));

  return {
    month: monthParam,
    restaurantName: restaurant?.name ?? "Unknown",
    generatedAt: new Date().toISOString(),
    baseReference: MONTHLY_BASE_HOURS,
    otThreshold: HCR_OT_THRESHOLD,
    workers: payrollWorkers,
    totals: {
      baseHours: sum(w => w.baseHours),
      totalHours: sum(w => w.totalHours),
      overtimeHours: sum(w => w.overtimeHours),
      ot110: sum(w => w.ot110),
      ot120: sum(w => w.ot120),
      ot150: sum(w => w.ot150),
      daysWorked: sum(w => w.daysWorked),
      holidayDays: sum(w => w.holidayDays),
      sickDays: sum(w => w.sickDays),
    },
  };
}

// ── CSV generation ──

const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export function payrollToCSV(data: PayrollExport): string {
  const [yearStr, monthStr] = data.month.split("-");
  const monthLabel = `${MONTHS_FR[parseInt(monthStr) - 1]} ${yearStr}`;

  const lines: string[] = [];

  // Header metadata
  lines.push(`EXPORT PAIE;${data.restaurantName}`);
  lines.push(`Période;${monthLabel}`);
  lines.push(`Généré le;${new Date(data.generatedAt).toLocaleString("fr-FR")}`);
  lines.push(`Base mensuelle;${data.baseReference}h`);
  lines.push(`Seuil HS hebdo;${data.otThreshold}h (Convention HCR)`);
  lines.push("");

  // Column headers
  lines.push([
    "Nom",
    "Rôle",
    "Jours travaillés",
    "Services",
    "Heures totales",
    "Heures normales",
    "HS totales",
    "HS 110%",
    "HS 120%",
    "HS 150%",
    "Congés payés (j)",
    "Maladie (j)",
    "Repas (j)",
  ].join(";"));

  // Worker rows
  for (const w of data.workers) {
    lines.push([
      w.name,
      w.role === "kitchen" ? "Cuisine" : "Salle",
      w.daysWorked,
      w.servicesWorked,
      w.totalHours.toFixed(2),
      w.baseHours.toFixed(2),
      w.overtimeHours.toFixed(2),
      w.ot110.toFixed(2),
      w.ot120.toFixed(2),
      w.ot150.toFixed(2),
      w.holidayDays,
      w.sickDays,
      w.mealDays,
    ].join(";"));
  }

  // Totals
  lines.push("");
  lines.push([
    "TOTAL",
    "",
    data.totals.daysWorked,
    "",
    data.totals.totalHours.toFixed(2),
    data.totals.baseHours.toFixed(2),
    data.totals.overtimeHours.toFixed(2),
    data.totals.ot110.toFixed(2),
    data.totals.ot120.toFixed(2),
    data.totals.ot150.toFixed(2),
    data.totals.holidayDays,
    data.totals.sickDays,
    "",
  ].join(";"));

  // Weekly detail section
  lines.push("");
  lines.push("DETAIL HEBDOMADAIRE");
  lines.push("");

  for (const w of data.workers) {
    if (w.weeks.length === 0) continue;
    lines.push(`${w.name} (${w.role === "kitchen" ? "Cuisine" : "Salle"})`);
    lines.push(["Semaine", "Du", "Au", "Heures semaine", "Heures mois", "HS", "HS 110%", "HS 120%", "HS 150%", "Chevauchement"].join(";"));
    for (const wk of w.weeks) {
      lines.push([
        `S${wk.weekNum}`,
        wk.from,
        wk.to,
        wk.totalHours.toFixed(2),
        wk.monthHours.toFixed(2),
        wk.overtime.toFixed(2),
        wk.breakdown.rate110.toFixed(2),
        wk.breakdown.rate120.toFixed(2),
        wk.breakdown.rate150.toFixed(2),
        wk.straddling ? "Oui" : "",
      ].join(";"));
    }
    lines.push("");
  }

  lines.push("");
  lines.push("DETAIL ANALYTIQUE");
  lines.push("");

  for (const w of data.workers) {
    if (w.analytics.length === 0) continue;
    lines.push(`${w.name} (${w.role === "kitchen" ? "Cuisine" : "Salle"})`);
    lines.push(["Restaurant", "Services", "Jours", "Heures", "Heures normales", "HS 110%", "HS 120%", "HS 150%"].join(";"));
    for (const section of w.analytics) {
      lines.push([
        section.restaurantName,
        section.serviceCount,
        section.daysWorked,
        section.totalHours.toFixed(2),
        section.baseHours.toFixed(2),
        section.ot110.toFixed(2),
        section.ot120.toFixed(2),
        section.ot150.toFixed(2),
      ].join(";"));
    }
    lines.push("");
  }

  // Append UTF-8 BOM for Excel compatibility
  return "\uFEFF" + lines.join("\r\n");
}

// ── Silae format ──
// Silae import: flat CSV file, semicolon-separated, one table only.
// Columns: Matricule;Code;Valeur;Date début;Date fin;Section analytique
// Date format: DD/MM/YYYY.
// One row per variable per worker and analytical restaurant section.
//
// Default HCR rubrique codes (must match the target My Silae dossier):
//   HS-HN          = Heures normales
//   HS-HS10        = Heures supplémentaires majorées à 10%
//   HS-HS20        = Heures supplémentaires majorées à 20%
//   HS-HS50        = Heures supplémentaires majorées à 50%
//   AB-300         = Congés payés (jours)
//   AB-100         = Absence maladie (jours)
//   EV-RepasServis = Avantage en nature repas (jours)

export const SILAE_DEFAULT_CODES: Record<string, string> = {
  heuresNormales: "HS-HN",
  hs110: "HS-HS10",
  hs120: "HS-HS20",
  hs150: "HS-HS50",
  congesPayes: "AB-300",
  maladie: "AB-100",
  repas: "EV-RepasServis",
};

export function normalizeSilaeCodes(codes: unknown): Record<string, string> {
  const merged = { ...SILAE_DEFAULT_CODES };
  if (!codes || typeof codes !== "object" || Array.isArray(codes)) return merged;
  for (const key of Object.keys(SILAE_DEFAULT_CODES)) {
    const value = (codes as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      merged[key] = value.trim();
    }
  }
  return merged;
}

export function missingSilaeMatricules(data: PayrollExport): string[] {
  return data.workers
    .filter(w => !w.matricule?.trim())
    .map(w => w.name);
}

export function silaeMatriculePlaceholder(worker: Pick<PayrollWorker, "workerId">): string {
  return `MISSING-${worker.workerId.slice(0, 8).toUpperCase()}`;
}

export function payrollToSilae(
  data: PayrollExport,
  codes: Record<string, string> = SILAE_DEFAULT_CODES,
): string {
  const [yearStr, monthStr] = data.month.split("-");
  const dateDebut = `01/${monthStr}/${yearStr}`; // DD/MM/YYYY

  const missingMatricules = missingSilaeMatricules(data);
  if (missingMatricules.length > 0) {
    throw new Error(`Export Silae impossible: matricule manquant pour ${missingMatricules.join(", ")}`);
  }

  const lines: string[] = ["Matricule;Code;Valeur;Date début;Date fin;Section analytique"];

  const emit = (mat: string, code: string, value: number, startDate: string, endDate = "", sectionName = "") => {
    if (value <= 0) return;
    const valStr = value.toFixed(2).replace(".", ",");
    lines.push(`${mat};${code};${valStr};${startDate};${endDate};${sectionName}`);
  };

  for (const w of data.workers) {
    const mat = w.matricule?.trim();
    if (!mat) continue;

    for (const section of w.analytics) {
      emit(mat, codes.heuresNormales, section.baseHours, dateDebut, "", section.restaurantName);
      emit(mat, codes.hs110, section.ot110, dateDebut, "", section.restaurantName);
      emit(mat, codes.hs120, section.ot120, dateDebut, "", section.restaurantName);
      emit(mat, codes.hs150, section.ot150, dateDebut, "", section.restaurantName);
      emit(mat, codes.repas, section.daysWorked, dateDebut, "", section.restaurantName);
    }

    for (const absence of w.absences) {
      const code = absence.type === "sick" ? codes.maladie : codes.congesPayes;
      emit(mat, code, absence.days, formatSilaeDate(absence.startDate), formatSilaeDate(absence.endDate), data.restaurantName);
    }
  }

  // No BOM: keep the import file raw UTF-8 for Silae.
  return lines.join("\r\n");
}
