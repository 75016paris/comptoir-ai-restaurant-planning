import { db, rawDb } from "./connection.js";
import {
  owners,
  restaurants,
  ownerMemberships,
  restaurantMemberships,
  workerRestaurantProfiles,
  workerShareAuthorizations,
  users,
  services,
  replacementRequests,
  holidayRequests,
  openShifts,
  notifications,
  sessions,
  dailyRevenue,
  timeClocks,
  serviceTemplates,
  serviceTemplateOverrides,
  workerAvailability,
  workerRestrictions,
  workerPreferredSchedule,
  restaurantClosures,
  staffingTargets,
  staffingProfiles,
  staffingSchedule,
  documents,
  chatMessages,
  weatherData,
  calendarEvents,
  publishedWeeks,
} from "./schema.js";
import { and, gte, lte, eq, inArray } from "drizzle-orm";
import { hash } from "argon2";
import { zonedDateTimeToUtc } from "@comptoir/shared";
import { DEFAULT_CONTRACT_HOURS, DEFAULT_CONTRACT_TYPE } from "@comptoir/shared";
import { refreshCalendarEvents } from "../services/calendar.js";
import { geocodeAddress, refreshWeather } from "../services/weather.js";
import { detectZones } from "../services/calendar.js";
import { replacementReplyExpiresAt } from "../services/replacement-deadline.js";
import { generatePlan } from "../routes/autostaffing.js";
import { computeLeaveIntelligence } from "../services/leave-intelligence.js";
import { weekDates } from "../utils/scheduling.js";

// ── Helpers ──

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// Realistic HCR 2026 compensation based on sub-role and position.
// SMIC hospitality 2026 ≈ 11.88€/h. Rates are indicative, based on HCR
// convention grids (Niveau I…V, Échelon 1/2). Admins can override later.
type CompSource = {
  name: string;
  role: string;
  subRoles: string;            // JSON array or "[]"
  contractType: string | null;
};
type CompResult = { hourlyRate: number; hcrLevel: string; overtimeWilling: boolean; priority: number };

// hourlyRate values below are human-readable euros; applyRealisticComp multiplies by 100
// before insert so the DB row stays in cents (the project-wide monetary convention).
function realisticComp(u: CompSource): CompResult {
  if (u.role === "admin") return { hourlyRate: 0, hcrLevel: "ADMIN", overtimeWilling: false, priority: 1 };
  // Manager (Responsable) — executive: paid like a senior salle but no schedule slots.
  if (u.role === "manager") return { hourlyRate: 17.00, hcrLevel: "IV-3", overtimeWilling: false, priority: 1 };
  let subs: string[] = [];
  try { subs = u.subRoles ? JSON.parse(u.subRoles) : []; } catch { subs = []; }

  // Deterministic OT-willing distribution: ~45% of non-CDI, ~30% of CDI willing.
  const seed = hashCode(u.name);
  const otWilling = u.contractType === "CDI"
    ? (seed % 100) < 30
    : (seed % 100) < 45;

  // Seniority priority — derived from sub-role and contract type.
  // 1 = most critical / senior; 5 = least critical / most fungible.
  if (subs.includes("Chef")) {
    return { hourlyRate: 18.50, hcrLevel: "V-1", overtimeWilling: otWilling, priority: 1 };
  }
  if (subs.includes("Sous-chef")) {
    return { hourlyRate: 16.00, hcrLevel: "IV-2", overtimeWilling: otWilling, priority: 1 };
  }
  if (subs.includes("Chef de rang")) {
    return { hourlyRate: 14.50, hcrLevel: "IV-1", overtimeWilling: otWilling, priority: 1 };
  }
  if (subs.includes("Sous-chef de rang")) {
    return { hourlyRate: 13.50, hcrLevel: "III-2", overtimeWilling: otWilling, priority: 2 };
  }
  if (subs.includes("Barman")) {
    return { hourlyRate: 13.50, hcrLevel: "III-2", overtimeWilling: otWilling, priority: 2 };
  }
  if (subs.includes("Cuisinier")) {
    return { hourlyRate: 13.00, hcrLevel: "III-1", overtimeWilling: otWilling, priority: 2 };
  }
  if (subs.includes("Serveur")) {
    return { hourlyRate: 12.50, hcrLevel: "II-2", overtimeWilling: otWilling, priority: 3 };
  }
  if (subs.includes("Plongeur")) {
    return { hourlyRate: 12.00, hcrLevel: "II-1", overtimeWilling: otWilling, priority: 4 };
  }
  if (u.role === "kitchen") return { hourlyRate: 13.00, hcrLevel: "III-1", overtimeWilling: otWilling, priority: 2 };
  if (u.role === "floor") return { hourlyRate: 12.50, hcrLevel: "II-2", overtimeWilling: otWilling, priority: 3 };
  return { hourlyRate: 11.88, hcrLevel: "I-1", overtimeWilling: false, priority: 5 };
}

// Fire a single UPDATE per user with compensation + OT-willing + priority.
function applyRealisticComp(createdUsers: Array<{ id: string; name: string; role: string; subRoles: string | null; contractType: string | null }>, effectiveDate: string): void {
  for (const u of createdUsers) {
    if (u.role === "admin") continue;
    const comp = realisticComp({
      name: u.name,
      role: u.role,
      subRoles: u.subRoles || "[]",
      contractType: u.contractType,
    });
    db.update(users).set({
      hourlyRate: Math.round(comp.hourlyRate * 100),
      hcrLevel: comp.hcrLevel,
      rateEffectiveFrom: effectiveDate,
      overtimeWilling: comp.overtimeWilling,
      priority: comp.priority,
    }).where(eq(users.id, u.id)).run();
  }
}

function randInt(min: number, max: number, seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  const r = x - Math.floor(x);
  return Math.floor(r * (max - min + 1)) + min;
}

function jitter(time: string, _maxMin: number, _seed: number): string {
  return time; // No jitter — use exact template times so autostaffing fill counting works
}

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function localIsoFromDateMinute(dateStr: string, minute: number, timeZone = "Europe/Paris"): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.floor(minute / (24 * 60)));
  const minuteOfDay = ((minute % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = Math.floor(minuteOfDay / 60).toString().padStart(2, "0");
  const mm = (minuteOfDay % 60).toString().padStart(2, "0");
  return zonedDateTimeToUtc(fmtDate(d), `${hh}:${mm}`, timeZone).toISOString();
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

function demoPublishedAtForWeek(monday: string): string {
  return `${addDays(monday, -21)} 09:00:00`;
}

type Worker = { id: string; name: string; email: string; role: string; contractHours: number | null };
type Service = {
  workerId: string; restaurantId: string; date: string;
  startTime: string; endTime: string; role: "kitchen" | "floor"; notes: string | null;
};
type HolidaySeedRow = typeof holidayRequests.$inferInsert;

function serviceOverlaps(a: Service, b: Service): boolean {
  let aStart = toMin(a.startTime), aEnd = toMin(a.endTime);
  let bStart = toMin(b.startTime), bEnd = toMin(b.endTime);
  if (aEnd <= aStart) aEnd += 24 * 60;
  if (bEnd <= bStart) bEnd += 24 * 60;
  return aStart < bEnd && bStart < aEnd;
}

// Weekly hour tracker for fair distribution in seed
const seedWeeklyHours = new Map<string, number>(); // "workerId_weekMonday" → hours
function getSeedWeekHours(workerId: string, weekMon: string): number {
  return seedWeeklyHours.get(`${workerId}_${weekMon}`) || 0;
}
function addSeedWeekHours(workerId: string, weekMon: string, mins: number) {
  const key = `${workerId}_${weekMon}`;
  seedWeeklyHours.set(key, (seedWeeklyHours.get(key) || 0) + mins / 60);
}
let currentSeedWeekMonday = ""; // set during service generation loop

function pick(arr: Worker[], n: number, seed: number): Worker[] {
  if (n >= arr.length) return [...arr];
  // Sort by contract deficit (workers furthest below quota first), with seed as tiebreaker
  const sorted = [...arr].sort((a, b) => {
    const aDef = (a.contractHours || 35) - getSeedWeekHours(a.id, currentSeedWeekMonday);
    const bDef = (b.contractHours || 35) - getSeedWeekHours(b.id, currentSeedWeekMonday);
    if (Math.abs(aDef - bDef) > 1) return bDef - aDef; // bigger deficit first
    // Tiebreaker: deterministic rotation
    const aIdx = arr.indexOf(a), bIdx = arr.indexOf(b);
    const start = Math.abs(seed) % arr.length;
    return ((aIdx - start + arr.length) % arr.length) - ((bIdx - start + arr.length) % arr.length);
  });
  return sorted.slice(0, n);
}

/** Pick n workers, skipping those whose existing day services would violate daily compliance */
function pickCompliant(
  arr: Worker[], n: number, seed: number,
  dayServices: Map<string, Array<{start: string; end: string}>>,
  newStart: string, newEnd: string,
  excludedIds = new Set<string>(),
): Worker[] {
  const newHrs = (toMin(newEnd) < toMin(newStart) ? toMin(newEnd) + 24 * 60 : toMin(newEnd)) - toMin(newStart);
  const MAX_DAILY_MIN = 10 * 60; // 10h max daily

  const available = arr.filter(w => {
    if (excludedIds.has(w.id)) return false;
    const existing = dayServices.get(w.id);
    if (!existing) return true;
    // Check time overlap with each existing service
    for (const s of existing) {
      let aS = toMin(s.start), aE = toMin(s.end);
      let bS = toMin(newStart), bE = toMin(newEnd);
      if (aE <= aS) aE += 24 * 60;
      if (bE <= bS) bE += 24 * 60;
      if (aS < bE && bS < aE) return false; // overlap
    }
    // Check total hours
    const existingMin = existing.reduce((sum, s) => {
      const e = toMin(s.end) < toMin(s.start) ? toMin(s.end) + 24 * 60 : toMin(s.end);
      return sum + (e - toMin(s.start));
    }, 0);
    return (existingMin + newHrs) <= MAX_DAILY_MIN;
  });
  return pick(available, n, seed);
}

/** Record a service assignment for compliance tracking */
function trackService(dayServices: Map<string, Array<{start: string; end: string}>>, workerId: string, start: string, end: string) {
  if (!dayServices.has(workerId)) dayServices.set(workerId, []);
  dayServices.get(workerId)!.push({ start, end });
}

// No complex rolling compliance in seed — seed data will be manually adjusted to be compliant

const BATCH = 50;
function batchInsert<T>(table: any, rows: T[]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    db.insert(table).values(rows.slice(i, i + BATCH) as any).run();
  }
}

function seedColumnExists(tableName: string, columnName: string): boolean {
  const rows = rawDb.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function seedTableExists(tableName: string): boolean {
  const row = rawDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
}

function createDemoOwner(name: string) {
  const [owner] = db.insert(owners).values({
    name,
    subscriptionStatus: "active",
  }).returning().all();
  return owner;
}

type SeedMembershipUser = {
  id: string;
  role: "admin" | "manager" | "kitchen" | "floor";
  permissions: string | null;
  active: boolean | number;
  priority: number;
  subRoles: string | null;
  contractType: "CDI" | "CDD" | "saisonnier" | "extra" | null;
  contractHours: number | null;
  contractEndDate: string | null;
  maxWeeklyHours: number | null;
  adminOtOverride: number | null;
  hcrLevel: string | null;
  hourlyRate: number | null;
  matricule: string | null;
  managerNotes: string | null;
  multiRestaurantWilling: boolean | number;
};

function seedMembershipsAndProfiles(ownerId: string, restaurantId: string, userIds: string[]): void {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => "?").join(", ");
  const rows = rawDb.query(`
    SELECT
      id,
      role,
      permissions,
      active,
      priority,
      sub_roles AS subRoles,
      contract_type AS contractType,
      contract_hours AS contractHours,
      contract_end_date AS contractEndDate,
      max_weekly_hours AS maxWeeklyHours,
      admin_ot_override AS adminOtOverride,
      hcr_level AS hcrLevel,
      hourly_rate AS hourlyRate,
      matricule,
      manager_notes AS managerNotes,
      multi_restaurant_willing AS multiRestaurantWilling
    FROM users
    WHERE id IN (${placeholders})
  `).all(...userIds) as SeedMembershipUser[];

  batchInsert(ownerMemberships, rows.map((user) => ({
    ownerId,
    userId: user.id,
    role: user.role === "admin" ? "owner_admin" : user.role === "manager" ? "owner_manager" : "member",
  })));

  batchInsert(restaurantMemberships, rows.map((user) => ({
    restaurantId,
    userId: user.id,
    role: user.role,
    permissions: user.permissions,
    active: user.active === true || user.active === 1,
  })));

  const workerRows = rows.filter((user) => user.role === "kitchen" || user.role === "floor");
  if (workerRows.length > 0) {
    batchInsert(workerRestaurantProfiles, workerRows.map((user) => ({
      restaurantId,
      userId: user.id,
      priority: user.priority,
      subRoles: user.subRoles ?? "[]",
      contractType: user.contractType,
      contractHours: user.contractHours,
      contractEndDate: user.contractEndDate,
      maxWeeklyHours: user.maxWeeklyHours,
      adminOtOverride: user.adminOtOverride,
      hcrLevel: user.hcrLevel,
      hourlyRate: user.hourlyRate,
      matricule: user.matricule,
      managerNotes: user.managerNotes,
      multiRestaurantWilling: user.multiRestaurantWilling === true || user.multiRestaurantWilling === 1,
    })));
  }
}

// ── Date anchors ──
const today = new Date();
today.setHours(12, 0, 0, 0);
const todayStr = fmtDate(today);
const currentMonday = new Date(today);
currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
const currentMondayStr = fmtDate(currentMonday);
const demoEmptyUntil = new Date(currentMonday);
demoEmptyUntil.setDate(currentMonday.getDate() + 13);
const demoEmptyUntilStr = fmtDate(demoEmptyUntil);

function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmtDate(d);
}

type DemoOwnerWorker = {
  id: string;
  name: string;
  role: "kitchen" | "floor";
};

type DemoPlannedLeave = {
  workerId: string;
  startDate: string;
  endDate: string;
};

function demoLeaveDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function demoLeaveOverlaps(a: DemoPlannedLeave, b: DemoPlannedLeave): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

function demoTargetTakenDays(worker: DemoOwnerWorker): number {
  const named: Record<string, number> = {
    "Jamie Foxx": 0,
    "Michelle Yeoh": 4,
    "Idris Elba": 4,
    "Viola Davis": 22,
    "Zendaya Coleman": 22,
    "Samuel L. Jackson": 23,
    "Ryan Gosling": 23,
    "Sandra Bullock": 23,
    "Timothee Chalamet": 23,
    "Scarlett Johansson": 24,
    "Robert De Niro": 24,
    "Matt Damon": 24,
    "Tom Hanks": 24,
    "Natalie Portman": 25,
    "Octavia Spencer": 25,
    "Michael B. Jordan": 25,
    "Mark Ruffalo": 25,
    "Margot Robbie": 25,
  };
  return named[worker.name] ?? (25 + (Math.abs(hashCode(worker.name)) % 3));
}

function demoCandidateDuration(worker: DemoOwnerWorker, weekIndex: number, remaining: number): number {
  const cycle = [5, 5, 5, 4, 5, 5];
  const wanted = cycle[(Math.abs(hashCode(worker.name)) + weekIndex) % cycle.length];
  return Math.max(1, Math.min(remaining, wanted));
}

function demoCandidateStart(monday: string, worker: DemoOwnerWorker, duration: number, weekIndex: number): string {
  if (duration >= 5) return monday;
  const offset = Math.abs(hashCode(`${worker.name}_${weekIndex}`)) % Math.max(1, 6 - duration);
  return addDays(monday, offset);
}

function countDemoUncoveredSlots(plan: Awaited<ReturnType<typeof generatePlan>>): number {
  const planned = new Map<string, Set<string>>();
  for (const service of plan.services) {
    const key = `${service.date}_${service.role}_${service.zone}`;
    if (!planned.has(key)) planned.set(key, new Set());
    planned.get(key)!.add(service.workerId);
  }
  let uncovered = 0;
  for (const slot of plan.slotFillSummary) {
    const date = weekDates(plan.week.from).find((d) => {
      const day = new Date(`${d}T12:00:00`).getDay();
      return (day === 0 ? 7 : day) === slot.dow;
    });
    const key = `${date}_${slot.role}_${slot.zone}`;
    if (slot.existingFill + (planned.get(key)?.size ?? 0) < slot.target) uncovered++;
  }
  return uncovered;
}

async function rebuildGrandBrasserieOwnerHistory(restaurantId: string): Promise<void> {
  const [admin] = db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.restaurantId, restaurantId), eq(users.role, "admin")))
    .limit(1)
    .all();
  if (!admin) throw new Error("Grand Brasserie admin missing during owner-history seed");

  const workers = db.select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.restaurantId, restaurantId), inArray(users.role, ["kitchen", "floor"]), eq(users.active, true)))
    .orderBy(users.role, users.name)
    .all() as DemoOwnerWorker[];
  if (workers.length !== 42) throw new Error(`Grand Brasserie owner-history seed expected 42 workers, got ${workers.length}`);

  rawDb.exec("PRAGMA foreign_keys = OFF");
  db.delete(replacementRequests).where(eq(replacementRequests.restaurantId, restaurantId)).run();
  db.delete(openShifts).where(eq(openShifts.restaurantId, restaurantId)).run();
  db.delete(timeClocks).where(eq(timeClocks.restaurantId, restaurantId)).run();
  db.delete(dailyRevenue).where(eq(dailyRevenue.restaurantId, restaurantId)).run();
  db.delete(publishedWeeks).where(eq(publishedWeeks.restaurantId, restaurantId)).run();
  db.delete(services).where(eq(services.restaurantId, restaurantId)).run();
  db.delete(holidayRequests).where(eq(holidayRequests.restaurantId, restaurantId)).run();
  rawDb.exec("PRAGMA foreign_keys = ON");

  const historyStart = "2025-01-06";
  const planningStart = "2025-06-02";
  const lastHistoricalMonday = addDays(currentMondayStr, -7);
  const taken = new Map(workers.map((worker) => [worker.id, 0]));
  const acceptedLeaves: DemoPlannedLeave[] = [];
  let accepted = 0;
  let rejected = 0;
  let staffedWeeks = 0;
  let insertedServices = 0;
  let intelligenceChecks = 0;
  let historicalUnderfilledWeeks = 0;

  const candidateOrder = (weekIndex: number): DemoOwnerWorker[] => [...workers].sort((a, b) => {
    const aGap = demoTargetTakenDays(a) - (taken.get(a.id) ?? 0);
    const bGap = demoTargetTakenDays(b) - (taken.get(b.id) ?? 0);
    if (bGap !== aGap) return bGap - aGap;
    return (Math.abs(hashCode(`${a.name}_${weekIndex}`)) % 97) - (Math.abs(hashCode(`${b.name}_${weekIndex}`)) % 97);
  });

  const tryLeave = async (worker: DemoOwnerWorker, monday: string, weekIndex: number, weekLeaves: DemoPlannedLeave[]): Promise<boolean> => {
    const remaining = demoTargetTakenDays(worker) - (taken.get(worker.id) ?? 0);
    if (remaining <= 0) return false;
    const duration = demoCandidateDuration(worker, weekIndex, remaining);
    const startDate = demoCandidateStart(monday, worker, duration, weekIndex);
    const endDate = addDays(startDate, duration - 1);
    const candidate = { workerId: worker.id, startDate, endDate };
    if (acceptedLeaves.some((leave) => leave.workerId === worker.id && demoLeaveOverlaps(leave, candidate))) return false;
    if (weekLeaves.some((leave) => leave.workerId === worker.id)) return false;

    const baseline = await generatePlan(restaurantId, monday, undefined, {
      holidayFilter: ["approved"],
      extraAbsences: weekLeaves,
      maxTier: 2,
    });
    if (baseline.solverUsed === "ilp-fallback") throw new Error(`CP-SAT unavailable while building demo baseline for ${monday}`);
    const baselineUncovered = countDemoUncoveredSlots(baseline);
    const baselineCompliance = baseline.complianceWarnings?.length ?? 0;

    const plan = await generatePlan(restaurantId, monday, undefined, {
      holidayFilter: ["approved"],
      extraAbsences: [...weekLeaves, candidate],
      maxTier: 2,
    });
    if (plan.solverUsed === "ilp-fallback") throw new Error(`CP-SAT unavailable while testing demo leave for ${worker.name} on ${monday}`);
    if (plan.solverStatus !== "optimal" && plan.solverStatus !== "feasible") {
      rejected++;
      return false;
    }
    if (countDemoUncoveredSlots(plan) > baselineUncovered || (plan.complianceWarnings?.length ?? 0) > baselineCompliance) {
      rejected++;
      return false;
    }

    db.insert(holidayRequests).values({
      workerId: worker.id,
      restaurantId,
      startDate,
      endDate,
      reason: "Planification CP assistée — couverture solveur OK.",
      status: "approved",
      source: "admin_proposal",
      reviewedBy: admin.id,
      reviewedAt: startDate,
      medical: false,
    }).run();

    acceptedLeaves.push(candidate);
    weekLeaves.push(candidate);
    taken.set(worker.id, (taken.get(worker.id) ?? 0) + demoLeaveDays(startDate, endDate));
    accepted++;
    return true;
  };

  const staffWeek = async (monday: string): Promise<void> => {
    const plan = await generatePlan(restaurantId, monday, undefined, { holidayFilter: ["approved"], maxTier: 2 });
    if (plan.solverUsed === "ilp-fallback") throw new Error(`CP-SAT unavailable while staffing demo week ${monday}`);
    if (plan.solverStatus !== "optimal" && plan.solverStatus !== "feasible") throw new Error(`No feasible demo staffing plan for ${monday}`);
    if (countDemoUncoveredSlots(plan) > 0) historicalUnderfilledWeeks++;
    if (plan.services.length > 0) {
      db.insert(services).values(plan.services.map((service) => ({
        workerId: service.workerId,
        restaurantId,
        date: service.date,
        startTime: service.startTime,
        endTime: service.endTime,
        role: service.role,
        source: "auto" as const,
        status: "scheduled" as const,
        filledAs: service.filledAs ?? null,
        notes: "Historique staffé par auto-solver.",
      }))).run();
    }
    db.insert(publishedWeeks).values({
      restaurantId,
      weekDate: monday,
      publishedAt: demoPublishedAtForWeek(monday),
    }).run();
    const revenueRows = weekDates(monday)
      .filter((date) => date < todayStr && date < currentMondayStr)
      .map((date) => {
        const dow = new Date(`${date}T12:00:00`).getDay();
        const dayBoost = dow === 5 ? 9800 : dow === 6 ? 8400 : dow === 0 ? 7600 : 5600;
        const variance = Math.abs(hashCode(`${restaurantId}_${date}`)) % 2400;
        return { restaurantId, date, amount: (dayBoost + variance) * 100, notes: null };
      });
    if (revenueRows.length > 0) db.insert(dailyRevenue).values(revenueRows).run();
    staffedWeeks++;
    insertedServices += plan.services.length;
  };

  let weekIndex = 0;
  for (let monday = historyStart; monday <= lastHistoricalMonday; monday = addDays(monday, 7), weekIndex++) {
    const weekLeaves: DemoPlannedLeave[] = [];
    if (monday >= planningStart) {
      const maxLeaves = weekIndex % 6 === 0 ? 3 : weekIndex % 3 === 0 ? 5 : 4;
      const roleCount = new Map<DemoOwnerWorker["role"], number>([["kitchen", 0], ["floor", 0]]);
      for (const worker of candidateOrder(weekIndex)) {
        if (weekLeaves.length >= maxLeaves) break;
        if ((roleCount.get(worker.role) ?? 0) >= 3) continue;
        const ok = await tryLeave(worker, monday, weekIndex, weekLeaves);
        if (ok) roleCount.set(worker.role, (roleCount.get(worker.role) ?? 0) + 1);
      }
      if (accepted > 0 && accepted % 8 === 0) {
        await computeLeaveIntelligence(restaurantId);
        intelligenceChecks++;
      }
    }
    await staffWeek(monday);
  }

  const pendingRows = [
    { name: "Al Pacino", startDate: addDays(currentMondayStr, 7), endDate: addDays(currentMondayStr, 11), reason: "Opération du genou — le médecin dit 5 jours minimum. HOO-AH.", medical: true },
    { name: "Angelina Jolie", startDate: addDays(currentMondayStr, 7), endDate: addDays(currentMondayStr, 11), reason: "Mission humanitaire au Cambodge. Je serai joignable par satellite.", medical: false },
    { name: "Brad Pitt", startDate: addDays(currentMondayStr, 14), endDate: addDays(currentMondayStr, 17), reason: "Festival de Cannes. Promotion du nouveau film. Je ramène du rosé.", medical: false },
    { name: "Keanu Reeves", startDate: addDays(currentMondayStr, 21), endDate: addDays(currentMondayStr, 23), reason: "Retraite silencieuse au Japon. Pas de téléphone, pas de mail, juste le zen.", medical: false },
  ];
  for (const pending of pendingRows) {
    const worker = workers.find((w) => w.name === pending.name);
    if (!worker) continue;
    db.insert(holidayRequests).values({
      workerId: worker.id,
      restaurantId,
      startDate: pending.startDate,
      endDate: pending.endDate,
      reason: pending.reason,
      status: "pending",
      source: "worker",
      medical: pending.medical,
    }).run();
  }

  const bullock = workers.find((w) => w.name === "Sandra Bullock");
  if (bullock) {
    const sickDate = addDays(currentMondayStr, -4);
    db.insert(holidayRequests).values({
      workerId: bullock.id,
      restaurantId,
      startDate: sickDate,
      endDate: sickDate,
      reason: "Grippe saisonnière.",
      status: "approved",
      source: "worker",
      medical: true,
      reviewedBy: admin.id,
      reviewedAt: sickDate,
    }).run();
  }

  const intelligence = await computeLeaveIntelligence(restaurantId);
  const balances = intelligence.balances.filter((balance) => balance.role === "kitchen" || balance.role === "floor");
  const totalRemaining = Math.round(balances.reduce((sum, balance) => sum + balance.remainingDays, 0) * 10) / 10;
  const critical = balances.filter((balance) => balance.expiringSoon).length;
  const solverSuggestions = intelligence.advice.workerSuggestions.filter((suggestion) => suggestion.source === "solver").length;
  if (solverSuggestions === 0) throw new Error("Grand Brasserie owner-history seed expected solver-backed leave proposals");
  if (totalRemaining > 520) throw new Error(`Grand Brasserie owner-history seed left too much PTO (${totalRemaining}j)`);
  if (totalRemaining < 120) throw new Error(`Grand Brasserie owner-history seed left too little PTO (${totalRemaining}j)`);

  console.log(`  ✓ Owner week-by-week simulation: ${staffedWeeks} weeks, ${insertedServices} auto services`);
  console.log(`  ✓ ${accepted} PTO blocks approved one by one (${rejected} rejected by solver/compliance), ${historicalUnderfilledWeeks} historical week(s) intentionally underfilled`);
  console.log(`  ✓ Leave intelligence checked ${intelligenceChecks + 1} times — ${critical} critical balances, ${totalRemaining}j remaining, ${solverSuggestions} solver proposals`);
}

// No services after this date — planning stops here (congés/holidays can still exist after).
// The current and next weeks are deliberately empty so the demo opens on a
// clean "planning à remplir" moment.
const serviceCutoff = new Date(currentMonday);
serviceCutoff.setDate(currentMonday.getDate() + 13); // Sunday of current+1 week
const serviceCutoffStr = fmtDate(serviceCutoff);
const DEMO_HISTORY_START = new Date("2025-01-06T12:00:00"); // first Monday of January 2025
const DEMO_HISTORY_WEEKS = Math.max(26, Math.ceil((currentMonday.getTime() - DEMO_HISTORY_START.getTime()) / (7 * 24 * 3600 * 1000)));
const DEMO_FUTURE_SERVICE_WEEKS = 1; // loop through next week, but leave current+next empty
const DEMO_SERVICE_WEEKS = DEMO_HISTORY_WEEKS + 1 + DEMO_FUTURE_SERVICE_WEEKS;

// ══════════════════════════════════════════════════════════════════════════════
// SEED
// ══════════════════════════════════════════════════════════════════════════════

async function seed() {
  console.log("🌱 Seeding database (demo restaurants only)...\n");

  // ── Idempotent cleanup: only delete data belonging to demo restaurants ──
  // Real customer restaurants (status != 'demo') are untouched.
  const demoIds = db.select({ id: restaurants.id })
    .from(restaurants)
    .where(eq(restaurants.status, "demo"))
    .all()
    .map(r => r.id);

  if (demoIds.length > 0) {
    console.log(`  🗑️  Cleaning ${demoIds.length} demo restaurant(s): ${demoIds.join(", ")}`);
    const placeholders = demoIds.map(() => "?").join(", ");
    const demoOwnerIds = rawDb.query(`
      SELECT DISTINCT owner_id AS id
      FROM restaurants
      WHERE status = 'demo' AND owner_id IS NOT NULL
    `).all() as Array<{ id: string }>;
    const ownerIds = demoOwnerIds.map((row) => row.id);
    const ownerPlaceholders = ownerIds.map(() => "?").join(", ");
    const demoOnlyOwnerIds = rawDb.query(`
      SELECT DISTINCT owner_id AS id
      FROM restaurants demo_restaurants
      WHERE status = 'demo'
        AND owner_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM restaurants other_restaurants
          WHERE other_restaurants.owner_id = demo_restaurants.owner_id
            AND other_restaurants.status <> 'demo'
        )
    `).all() as Array<{ id: string }>;
    const ownerLevelIds = demoOnlyOwnerIds.map((row) => row.id);
    const ownerLevelPlaceholders = ownerLevelIds.map(() => "?").join(", ");
    const templateIds = rawDb.query(`
      SELECT id
      FROM service_templates
      WHERE restaurant_id IN (${placeholders})
    `).all(...demoIds) as Array<{ id: string }>;
    const templateIdList = templateIds.map((row) => row.id);
    const templatePlaceholders = templateIdList.map(() => "?").join(", ");

    // Tables with a restaurant_id column — deleted directly per restaurant.
    // Order matters: tables that hold FKs into other byRestaurant tables must come
    // BEFORE their targets, otherwise SQLite will reject the parent delete with
    // "FOREIGN KEY constraint failed". Group is leaf-first → trunk-last.
    //
    // Why some tables that also have a users(id) FK live here rather than in
    // byUser: a per-restaurant DELETE wipes the entire scope in one statement
    // and avoids the user-lookup roundtrip. Anything with restaurant_id should
    // be here.
    if (templateIdList.length > 0) {
      rawDb.run(`DELETE FROM service_template_overrides WHERE template_id IN (${templatePlaceholders})`, templateIdList);
    }
    rawDb.run(
      `DELETE FROM sessions WHERE active_restaurant_id IN (${placeholders})
       OR user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))`,
      [...demoIds, ...demoIds],
    );
    rawDb.run(
      `DELETE FROM worker_share_authorizations
       WHERE source_restaurant_id IN (${placeholders})
          OR target_restaurant_id IN (${placeholders})
          OR user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))
          OR invited_by_user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))`,
      [...demoIds, ...demoIds, ...demoIds, ...demoIds],
    );
    rawDb.run(
      `DELETE FROM legal_acceptances
       WHERE restaurant_id IN (${placeholders})
          OR user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))
          ${ownerLevelIds.length > 0 ? `OR owner_id IN (${ownerLevelPlaceholders})` : ""}`,
      ownerLevelIds.length > 0 ? [...demoIds, ...demoIds, ...ownerLevelIds] : [...demoIds, ...demoIds],
    );
    const notificationConditions = [
      seedColumnExists("notifications", "restaurant_id") ? `restaurant_id IN (${placeholders})` : null,
      seedColumnExists("notifications", "recipient_id") ? `recipient_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))` : null,
      ownerLevelIds.length > 0 && seedColumnExists("notifications", "owner_id") ? `owner_id IN (${ownerLevelPlaceholders})` : null,
    ].filter(Boolean);
    if (notificationConditions.length > 0) {
      const notificationParams = [
        ...(seedColumnExists("notifications", "restaurant_id") ? demoIds : []),
        ...(seedColumnExists("notifications", "recipient_id") ? demoIds : []),
        ...(ownerLevelIds.length > 0 && seedColumnExists("notifications", "owner_id") ? ownerLevelIds : []),
      ];
      rawDb.run(`DELETE FROM notifications WHERE ${notificationConditions.join(" OR ")}`, notificationParams);
    }
    if (ownerLevelIds.length > 0 && seedColumnExists("cron_runs", "owner_id")) {
      rawDb.run(`DELETE FROM cron_runs WHERE owner_id IN (${ownerLevelPlaceholders})`, ownerLevelIds);
    }

    const byRestaurant = [
      // 1. Leaves — no other byRestaurant table FKs to these.
      "audit_logs", "weather_data", "calendar_events", "daily_revenue",
      "worker_availability", "worker_restrictions", "worker_preferred_schedule",
      "service_templates", "staffing_targets", "staffing_schedule", "staffing_profiles",
      "staffing_analysis_cache",
      "restaurant_closures", "published_weeks", "contract_templates", "email_recipients",
      "admin_alerts",

      // 2. Tables that hold FKs into services / holiday_requests / replacement_requests —
      //    must precede them.
      "time_clocks",   // time_clocks.service_id → services.id
      "open_shifts",   // open_shifts.service_id → services.id
      "documents",     // documents.holiday_request_id, .replacement_request_id
      "restriction_requests",

      // 3. Things that FK into services. Must precede services.
      "replacement_requests",  // requester_service_id → services.id
      "holiday_requests",

      // 4. services last — referenced by all of the above.
      "services",
    ];
    for (const table of byRestaurant) {
      if (!seedTableExists(table)) continue;
      rawDb.run(`DELETE FROM ${table} WHERE restaurant_id IN (${placeholders})`, demoIds);
    }

    // Tables with a user FK but NO restaurant_id — delete via user lookup.
    // If you add a new table that REFERENCES users(id), add it here (or to
    // byRestaurant if it has restaurant_id), otherwise the next demo reset will
    // fail with an opaque "FOREIGN KEY constraint failed" on DELETE FROM users.
    const byUser: Array<{ table: string; col: string }> = [
      { table: "chat_messages", col: "user_id" },
      { table: "password_reset_tokens", col: "user_id" },
      { table: "onboarding_tokens", col: "user_id" },
    ];
    for (const { table, col } of byUser) {
      if (!seedTableExists(table)) continue;
      rawDb.run(
        `DELETE FROM ${table} WHERE ${col} IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))`,
        demoIds,
      );
    }

    rawDb.run(`DELETE FROM worker_restaurant_profiles WHERE restaurant_id IN (${placeholders}) OR user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))`, [...demoIds, ...demoIds]);
    rawDb.run(`DELETE FROM restaurant_memberships WHERE restaurant_id IN (${placeholders}) OR user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))`, [...demoIds, ...demoIds]);
    rawDb.run(
      `DELETE FROM owner_memberships
       WHERE user_id IN (SELECT id FROM users WHERE restaurant_id IN (${placeholders}))
          ${ownerLevelIds.length > 0 ? `OR owner_id IN (${ownerLevelPlaceholders})` : ""}`,
      ownerLevelIds.length > 0 ? [...demoIds, ...ownerLevelIds] : demoIds,
    );

    // Delete demo users, then demo restaurants
    rawDb.run(`DELETE FROM users WHERE restaurant_id IN (${placeholders})`, demoIds);
    rawDb.run(`DELETE FROM restaurants WHERE id IN (${placeholders})`, demoIds);
    if (ownerIds.length > 0) {
      rawDb.run(
        `DELETE FROM owners
         WHERE id IN (${ownerPlaceholders})
           AND NOT EXISTS (SELECT 1 FROM restaurants WHERE restaurants.owner_id = owners.id)`,
        ownerIds,
      );
    }
    console.log("  ✓ Demo data cleaned\n");
  } else {
    console.log("  No existing demo restaurants found — fresh seed\n");
  }

  const pw = await hash("comptoir123");

  // ════════════════════════════════════════════════════════════════════════════
  // RESTAURANT 1 — SIMPLE: "Chez Reno" (acteurs français, équipe resserrée)
  // ════════════════════════════════════════════════════════════════════════════

  const r1Owner = createDemoOwner("Chez Reno");
  const [r1] = db.insert(restaurants).values({
    ownerId: r1Owner.id,
    name: "Chez Reno",
    address: "42 Rue du Faubourg Saint-Antoine, 75012 Paris",
    timezone: "Europe/Paris",
    status: "demo",
    onboardingCompletedAt: new Date().toISOString(),
    colorScheme: "sunset",
    workerPreferencesEnabled: false,
    tapInOutEnabled: true,
    tapInOutMode: "sync",
    medicalMode: false,
    reminderFrequency: "off",
    autoStaffingWeeks: 3,
    disabledComplianceRules: JSON.stringify(["HCR-L3121-16"]),
    preferredStyle: "equipe-stable",
    overtimeMode: "flexible",
    defaultContractType: DEFAULT_CONTRACT_TYPE,
    defaultContractHours: DEFAULT_CONTRACT_HOURS,
  }).returning().all();

  // Geocode address via BAN (api-adresse.data.gouv.fr)
  const r1Geo = await geocodeAddress(r1.address!);
  if (r1Geo) {
    const r1Zones = detectZones(r1.address!);
    db.update(restaurants).set({
      latitude: Math.round(r1Geo.lat * 1e6),
      longitude: Math.round(r1Geo.lon * 1e6),
      ...(r1Zones ?? {}),
    }).where(eq(restaurants.id, r1.id)).run();
    console.log(`  ✓ Restaurant 1: ${r1.name} (Simple) — geocoded: ${r1Geo.lat.toFixed(4)}, ${r1Geo.lon.toFixed(4)}`);
  } else {
    console.log(`  ✓ Restaurant 1: ${r1.name} (Simple) — geocoding failed, no weather/calendar`);
  }

  // ── Users: French actors ──
  const r1Users = [
    { name: "Jean Reno", email: "reno@chezreno.fr", phone: "+33600100001", role: "admin" as const, priority: 1,
      notes: "Le gérant. Parle peu mais quand il parle, tout le monde écoute.", managerNotes: null },
    { name: "Sophie Marceau", email: "marceau@chezreno.fr", phone: "+33600100015", role: "manager" as const, priority: 1,
      notes: "Responsable de salle adjointe. Gère le planning quand Jean est absent.", managerNotes: "Bras droit du gérant. Confiance totale." },
    { name: "Jean Dujardin", email: "dujardin@chezreno.fr", phone: "+33600100002", role: "kitchen" as const, priority: 1, subRoles: '["Chef","Cuisinier"]',
      notes: "Cuisine avec le sourire. Dit 'OSS 117' à chaque plat envoyé.", managerNotes: "Chef naturel. Charisme dévastateur même en tablier." },
    { name: "Gérard Depardieu", email: "depardieu@chezreno.fr", phone: "+33600100003", role: "kitchen" as const, priority: 2, subRoles: '["Cuisinier"]',
      notes: "Portions généreuses. Goûte chaque plat (deux fois). Vignoble personnel.", managerNotes: "Les clients repartent toujours repus. Attention au stock de vin." },
    { name: "Audrey Tautou", email: "tautou@chezreno.fr", phone: "+33600100009", role: "kitchen" as const, priority: 3, subRoles: '["Cuisinier","Commis"]',
      notes: "Renfort cuisine CDI 35h, arrivée pour rendre les congés possibles sans fermer le service.", managerNotes: "Polyvalente et fiable. Absorbe les services du midi et les remplacements courts." },
    { name: "Juliette Binoche", email: "binoche@chezreno.fr", phone: "+33600100010", role: "kitchen" as const, priority: 4, subRoles: '["Cuisinier","Commis"]',
      notes: "Deuxième renfort cuisine CDI 35h. Présente sur les semaines de roulement CP et les soirs tendus.", managerNotes: "Stabilise la cuisine quand Jean ou Gérard prend une vraie coupure." },
    { name: "Omar Sy", email: "sy@chezreno.fr", phone: "+33600100005", role: "floor" as const, priority: 1, subRoles: '["Chef de rang","Serveur"]',
      notes: "Énergie contagieuse. Les clients reviennent pour son accueil autant que pour la cuisine.", managerNotes: "Meilleur vendeur de desserts. Quand Omar propose, personne ne refuse." },
    { name: "Marion Cotillard", email: "cotillard@chezreno.fr", phone: "+33600100006", role: "floor" as const, priority: 2, subRoles: '["Chef de rang","Serveur"]',
      notes: "Service impeccable. Présente chaque plat comme si c'était un Oscar.", managerNotes: "Professionnelle jusqu'au bout des ongles. Les VIP la demandent." },
    { name: "Dany Boon", email: "boon@chezreno.fr", phone: "+33600100007", role: "floor" as const, priority: 3, subRoles: '["Serveur"]',
      notes: "Accent ch'ti assumé. Les clients du Nord se sentent chez eux, les autres sont charmés.", managerNotes: "Fait rire toute la salle. Les pourboires suivent." },
    { name: "Léa Seydoux", email: "seydoux@chezreno.fr", phone: "+33600100008", role: "floor" as const, priority: 4, subRoles: '["Serveur"]',
      notes: "Renfort salle CDI 35h. Élégante et efficace, elle stabilise les périodes de congés.", managerNotes: "Parfaite pour garder de la marge sur les soirs chargés et les absences." },
  ];

  const r1Created = db.insert(users).values(
    r1Users.map(u => ({
      ...u,
      passwordHash: pw,
      restaurantId: r1.id,
      address: null,
      iban: null,
      managerNotes: u.managerNotes,
      startDate: u.role === "admin" || u.role === "manager" ? null : ((u as { startDate?: string }).startDate ?? "2025-01-01"),
      multiRestaurantWilling: u.role === "kitchen" || u.role === "floor",
    }))
  ).returning().all();
  r1Created.forEach(u => console.log(`    ${u.role === "admin" ? "👑" : u.role === "manager" ? "🎩" : u.role === "kitchen" ? "🍳" : "🍽️ "} ${u.name}`));

  // ── Contract data ──
  const contractData: Record<string, { type: "CDI" | "CDD" | "saisonnier"; hours: number }> = {
    "Jean Dujardin": { type: "CDI", hours: 39 },
    "Gérard Depardieu": { type: "CDI", hours: 35 },
    "Audrey Tautou": { type: "CDI", hours: 35 },
    "Juliette Binoche": { type: "CDI", hours: 35 },
    "Omar Sy": { type: "CDI", hours: 35 },
    "Marion Cotillard": { type: "CDI", hours: 35 },
    "Dany Boon": { type: "CDI", hours: 35 },
    "Léa Seydoux": { type: "CDI", hours: 35 },
  };
  for (const u of r1Created) {
    const c = contractData[u.name];
    if (c) {
      db.update(users).set({ contractType: c.type, contractHours: c.hours }).where(eq(users.id, u.id)).run();
    }
  }
  console.log("  ✓ Contract data");

  const r1CreatedWithContracts = r1Created.map(u => ({
    ...u,
    contractType: contractData[u.name]?.type ?? u.contractType,
    contractHours: contractData[u.name]?.hours ?? u.contractHours,
  }));

  // Realistic compensation (HCR level + hourly rate) + OT-willing + priority variance
  const r1ForComp = r1CreatedWithContracts.map(u => ({ ...u, contractType: contractData[u.name]?.type ?? null }));
  applyRealisticComp(r1ForComp, fmtDate(currentMonday));
  seedMembershipsAndProfiles(r1Owner.id, r1.id, r1Created.map((user) => user.id));
  console.log("  ✓ Compensation + OT-willing + priority (HCR-based)");

  // ── Service templates: small restaurant, two clear services only ──
  // ── Single staffing profile ──
  const [r1Profile] = db.insert(staffingProfiles)
    .values({ restaurantId: r1.id, name: "", sortOrder: 0 })
    .returning({ id: staffingProfiles.id }).all();

  db.insert(serviceTemplates).values([
    { restaurantId: r1.id, profileId: r1Profile.id, role: "kitchen", zone: "MIDI", startTime: "10:15", endTime: "15:15", sortOrder: 1 },
    { restaurantId: r1.id, profileId: r1Profile.id, role: "floor",  zone: "MIDI", startTime: "10:15", endTime: "15:15", sortOrder: 1 },
    { restaurantId: r1.id, profileId: r1Profile.id, role: "kitchen", zone: "SOIR", startTime: "18:00", endTime: "23:00", sortOrder: 2 },
    { restaurantId: r1.id, profileId: r1Profile.id, role: "floor",  zone: "SOIR", startTime: "18:00", endTime: "23:00", sortOrder: 2 },
  ]).run();
  console.log("  ✓ Service templates: MIDI + SOIR (profile)");

  // Simple targets: 1 objectif, Tue-Sun.
  // The 4K + 4S brigade carries nearly full CDI-35 volume with two readable
  // services. Busy dinners need most of the team; CP weeks lean on the spare
  // capacity without forcing a closure.
  const r1Targets: Array<{ day: number; role: "kitchen" | "floor"; zone: string; count: number }> = [
    // Tue-Thu (calme): two at lunch, reinforced dinner.
    ...[2, 3, 4].flatMap(d => [
      { day: d, role: "kitchen" as const, zone: "MIDI", count: 2 }, { day: d, role: "floor" as const, zone: "MIDI", count: 2 },
      { day: d, role: "kitchen" as const, zone: "SOIR", count: 3 }, { day: d, role: "floor" as const, zone: "SOIR", count: 3 },
    ]),
    // Fri (actif): stronger lunch and dinner.
    { day: 5, role: "kitchen", zone: "MIDI", count: 3 }, { day: 5, role: "floor", zone: "MIDI", count: 2 },
    { day: 5, role: "kitchen", zone: "SOIR", count: 3 }, { day: 5, role: "floor", zone: "SOIR", count: 3 },
    // Sat (complet): lunch stays lean; dinner gets the full team.
    { day: 6, role: "kitchen", zone: "MIDI", count: 2 }, { day: 6, role: "floor", zone: "MIDI", count: 2 },
    { day: 6, role: "kitchen", zone: "SOIR", count: 3 }, { day: 6, role: "floor", zone: "SOIR", count: 3 },
    // Sun (brunch midi only): lighter service after the Saturday night rush.
    { day: 7, role: "kitchen", zone: "MIDI", count: 3 }, { day: 7, role: "floor", zone: "MIDI", count: 4 },
  ];
  db.insert(staffingTargets).values(
    r1Targets.map(t => ({ restaurantId: r1.id, profileId: r1Profile.id, dayOfWeek: t.day, role: t.role, zone: t.zone, count: t.count }))
  ).run();
  console.log(`  ✓ Staffing targets (${r1Targets.length} entries, 1 profile)`);

  const r1IsoWeek = (d: Date): { year: number; week: number } => {
    const tmp = new Date(d.getTime());
    tmp.setHours(0, 0, 0, 0);
    tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
    const jan4 = new Date(tmp.getFullYear(), 0, 4);
    const week = 1 + Math.round(((tmp.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return { year: tmp.getFullYear(), week };
  };
  const r1SchedRows: { restaurantId: string; profileId: string; year: number; week: number }[] = [];
  for (let w = -DEMO_HISTORY_WEEKS; w <= DEMO_FUTURE_SERVICE_WEEKS; w++) {
    const d = new Date(currentMonday); d.setDate(currentMonday.getDate() + w * 7);
    const iw = r1IsoWeek(d);
    r1SchedRows.push({ restaurantId: r1.id, profileId: r1Profile.id, year: iw.year, week: iw.week });
  }
  db.insert(staffingSchedule).values(r1SchedRows).run();
  console.log(`  ✓ ${r1SchedRows.length} weeks in staffing schedule`);

  // ── Worker restrictions (time-slot based unavailability) ──
  const r1Workers = r1CreatedWithContracts.filter(u => u.role !== "admin" && u.role !== "manager");
  const r1Kitchen = r1CreatedWithContracts.filter(u => u.role === "kitchen");
  const r1Servers = r1CreatedWithContracts.filter(u => u.role === "floor");

  const r1OwnerLeavePlanSeed: Array<{ worker: string; start: string; days: number }> = [
    { worker: "Dany Boon", start: "2025-03-03", days: 5 },
    { worker: "Jean Dujardin", start: "2025-03-10", days: 3 },
    { worker: "Léa Seydoux", start: "2025-03-17", days: 5 },
    { worker: "Marion Cotillard", start: "2025-03-24", days: 5 },
    { worker: "Omar Sy", start: "2025-03-31", days: 5 },
    { worker: "Dany Boon", start: "2025-04-28", days: 5 },
    { worker: "Audrey Tautou", start: "2025-05-05", days: 3 },
    { worker: "Gérard Depardieu", start: "2025-05-12", days: 3 },
    { worker: "Juliette Binoche", start: "2025-05-19", days: 3 },
    { worker: "Jean Dujardin", start: "2025-05-26", days: 3 },
    { worker: "Léa Seydoux", start: "2025-06-02", days: 5 },
    { worker: "Marion Cotillard", start: "2025-06-09", days: 5 },
    { worker: "Omar Sy", start: "2025-06-16", days: 5 },
    { worker: "Audrey Tautou", start: "2025-06-23", days: 3 },
    { worker: "Dany Boon", start: "2025-06-30", days: 5 },
    { worker: "Gérard Depardieu", start: "2025-07-07", days: 3 },
    { worker: "Juliette Binoche", start: "2025-07-14", days: 3 },
    { worker: "Jean Dujardin", start: "2025-07-21", days: 3 },
    { worker: "Léa Seydoux", start: "2025-07-28", days: 5 },
    { worker: "Marion Cotillard", start: "2025-08-04", days: 5 },
    { worker: "Omar Sy", start: "2025-08-11", days: 5 },
    { worker: "Audrey Tautou", start: "2025-08-18", days: 3 },
    { worker: "Gérard Depardieu", start: "2025-08-25", days: 3 },
    { worker: "Dany Boon", start: "2025-09-01", days: 5 },
    { worker: "Juliette Binoche", start: "2025-09-08", days: 3 },
    { worker: "Jean Dujardin", start: "2025-09-15", days: 3 },
    { worker: "Léa Seydoux", start: "2025-09-22", days: 5 },
    { worker: "Marion Cotillard", start: "2025-09-29", days: 5 },
    { worker: "Omar Sy", start: "2025-10-06", days: 5 },
    { worker: "Audrey Tautou", start: "2025-10-13", days: 3 },
    { worker: "Gérard Depardieu", start: "2025-10-20", days: 3 },
    { worker: "Dany Boon", start: "2025-10-27", days: 5 },
    { worker: "Juliette Binoche", start: "2025-11-03", days: 3 },
    { worker: "Jean Dujardin", start: "2025-11-10", days: 3 },
    { worker: "Léa Seydoux", start: "2025-11-17", days: 5 },
    { worker: "Marion Cotillard", start: "2025-11-24", days: 5 },
    { worker: "Omar Sy", start: "2025-12-01", days: 5 },
    { worker: "Audrey Tautou", start: "2025-12-08", days: 3 },
    { worker: "Gérard Depardieu", start: "2025-12-15", days: 3 },
    { worker: "Juliette Binoche", start: "2025-12-22", days: 3 },
    { worker: "Jean Dujardin", start: "2025-12-29", days: 3 },
    { worker: "Audrey Tautou", start: "2026-01-12", days: 3 },
    { worker: "Gérard Depardieu", start: "2026-01-19", days: 3 },
    { worker: "Juliette Binoche", start: "2026-01-26", days: 3 },
    { worker: "Jean Dujardin", start: "2026-02-02", days: 3 },
    { worker: "Audrey Tautou", start: "2026-02-16", days: 3 },
    { worker: "Gérard Depardieu", start: "2026-02-23", days: 3 },
    { worker: "Juliette Binoche", start: "2026-03-02", days: 3 },
  ];
  const r1WorkerByName = new Map(r1Workers.map(worker => [worker.name, worker]));
  const r1LeaveExclusions = (date: string, extra = new Set<string>()) => {
    const excluded = new Set(extra);
    for (const leave of r1OwnerLeavePlanSeed) {
      const worker = r1WorkerByName.get(leave.worker);
      if (worker && date >= leave.start && date <= addDays(leave.start, leave.days - 1)) excluded.add(worker.id);
    }
    return excluded;
  };
  const pickR1 = (
    arr: Worker[], n: number, seed: number,
    dayServices: Map<string, Array<{start: string; end: string}>>,
    newStart: string, newEnd: string, date: string,
    excludedIds = new Set<string>(),
  ) => pickCompliant(arr, n, seed, dayServices, newStart, newEnd, r1LeaveExclusions(date, excludedIds));

  // R1 template times by role.
  const r1Times: Record<string, Record<string, { start: string; end: string }>> = {
    kitchen: { MIDI: { start: "10:15", end: "15:15" }, SOIR: { start: "18:00", end: "23:00" } },
    floor:   { MIDI: { start: "10:15", end: "15:15" }, SOIR: { start: "18:00", end: "23:00" } },
  };

  const r1Restr: Record<string, { unavail?: number[]; midiOnly?: number[]; soirOnly?: number[] }> = {
    "Jean Dujardin": {},
    "Gérard Depardieu": {},
    "Audrey Tautou": {},
    "Juliette Binoche": {},
    "Omar Sy": {},
    "Marion Cotillard": {},
    "Dany Boon": {},
    "Léa Seydoux": {},
  };

  const r1RestrRows: any[] = [];
  for (const w of r1Workers) {
    const q = r1Restr[w.name] ?? {};
    const times = r1Times[w.role] || r1Times.floor;
    for (const day of (q.unavail || [])) {
      r1RestrRows.push({ workerId: w.id, restaurantId: r1.id, dayOfWeek: day, startTime: null, endTime: null, reason: "Jour de repos" });
    }
    for (const day of (q.midiOnly || [])) {
      // midiOnly = block SOIR
      r1RestrRows.push({ workerId: w.id, restaurantId: r1.id, dayOfWeek: day, startTime: times.SOIR.start, endTime: times.SOIR.end, reason: "Indisponible le soir" });
    }
    for (const day of (q.soirOnly || [])) {
      // soirOnly = block MIDI
      r1RestrRows.push({ workerId: w.id, restaurantId: r1.id, dayOfWeek: day, startTime: times.MIDI.start, endTime: times.MIDI.end, reason: "Indisponible le midi" });
    }
  }
  if (r1RestrRows.length > 0) db.insert(workerRestrictions).values(r1RestrRows).run();
  console.log(`  ✓ Worker restrictions (${r1RestrRows.length} restrictions for ${r1Workers.length} workers)`);

  // ── Closures ──
  const r1ClosureStart = new Date(currentMonday); r1ClosureStart.setDate(currentMonday.getDate() + 15);
  const r1ClosureEnd = new Date(r1ClosureStart); r1ClosureEnd.setDate(r1ClosureStart.getDate() + 2);
  const r1Closures = [
    { restaurantId: r1.id, startDate: "2025-05-01", endDate: "2025-05-01", reason: "Fête du Travail — restaurant fermé" },
    { restaurantId: r1.id, startDate: "2026-05-01", endDate: "2026-05-01", reason: "Fête du Travail — restaurant fermé" },
    { restaurantId: r1.id, startDate: fmtDate(r1ClosureStart), endDate: fmtDate(r1ClosureEnd), reason: "Travaux cuisine — remplacement du four" },
  ];
  db.insert(restaurantClosures).values(r1Closures).run();
  function isR1Closed(d: string) { return r1Closures.some(c => d >= c.startDate && d <= c.endDate); }

  // ── Services: historical data only ──
  // The current and next weeks are deliberately left empty in the demo. This
  // makes Planning open on the strongest sales moment: Comptoir knows the
  // staffing need, shows the missing services, and can fill the week.
  const r1AllServices: Service[] = [];
  const r1Revenue: { restaurantId: string; date: string; amount: number; notes: string | null }[] = [];
  const startMonday = new Date(currentMonday); startMonday.setDate(currentMonday.getDate() - DEMO_HISTORY_WEEKS * 7);

  const kitchenNotes1 = [
    "Dujardin a envoyé les plats en sifflant l'hymne national.", "Depardieu a goûté le bœuf bourguignon quatre fois.",
    null, null, null, null,
  ];
  const serverNotes1 = [
    "Omar a fait danser la table 5 sur du Earth Wind & Fire.", "Cotillard a présenté le plat du jour comme un discours aux Oscars.",
    "Boon a raconté une blague ch'ti — la table 3 a pleuré de rire.", null, null, null,
  ];

  function addR1Service(w: Worker, date: string, start: string, end: string, pool: (string | null)[]) {
    const noteIdx = Math.abs(hashCode(w.id + date)) % pool.length;
    r1AllServices.push({ workerId: w.id, restaurantId: r1.id, date, startTime: start, endTime: end, role: w.role as "kitchen" | "floor", notes: pool[noteIdx] });
    const mins = (toMin(end) < toMin(start) ? toMin(end) + 24 * 60 : toMin(end)) - toMin(start);
    addSeedWeekHours(w.id, currentSeedWeekMonday, mins);
  }

  for (let week = 0; week < DEMO_SERVICE_WEEKS; week++) {
    const weekMon1 = new Date(startMonday); weekMon1.setDate(startMonday.getDate() + week * 7);
    currentSeedWeekMonday = fmtDate(weekMon1);
    let previousKitchenDinnerIds = new Set<string>();
    for (let day = 0; day < 7; day++) {
      const d = new Date(startMonday); d.setDate(startMonday.getDate() + week * 7 + day);
      const date = fmtDate(d);
      const rot = week * 13 + day * 7;
      const isPast = date < todayStr;
      if (day === 0) { previousKitchenDinnerIds = new Set(); continue; } // Monday closed
      if (isR1Closed(date)) { previousKitchenDinnerIds = new Set(); continue; }
      if (date >= currentMondayStr && date <= demoEmptyUntilStr) { previousKitchenDinnerIds = new Set(); continue; }
      if (date > serviceCutoffStr) { previousKitchenDinnerIds = new Set(); continue; } // No planning after cutoff

      // Track per-worker services this day for compliance (no overlap, max 10h daily)
      const dayK = new Map<string, Array<{start: string; end: string}>>();
      const dayS = new Map<string, Array<{start: string; end: string}>>();

      if (day >= 1 && day <= 3) {
        // Tue-Thu (calme): lean lunch, two cooks at dinner for prep + service.
        const kMs = jitter("10:15", 15, rot), kMe = jitter("15:15", 15, rot+1);
        const sMs = jitter("10:15", 15, rot+3), sMe = jitter("15:15", 15, rot+4);
        const kSs = jitter("18:00", 15, rot+6), kSe = jitter("23:00", 15, rot+7);
        const sSs = jitter("18:00", 15, rot+9), sSe = jitter("23:00", 15, rot+10);
        const kM = pickR1(r1Kitchen, 2, rot, dayK, kMs, kMe, date); kM.forEach(w => {
          trackService(dayK, w.id, kMs, kMe); addR1Service(w, date, kMs, kMe, kitchenNotes1);
        });
        const sM = pickR1(r1Servers, 2, rot+2, dayS, sMs, sMe, date); sM.forEach(w => {
          trackService(dayS, w.id, sMs, sMe); addR1Service(w, date, sMs, sMe, serverNotes1);
        });
        const kS = pickR1(r1Kitchen, 3, rot+5, dayK, kSs, kSe, date); kS.forEach(w => {
          trackService(dayK, w.id, kSs, kSe); addR1Service(w, date, kSs, kSe, kitchenNotes1);
        });
        previousKitchenDinnerIds = new Set(kS.map(w => w.id));
        const sS = pickR1(r1Servers, 3, rot+8, dayS, sSs, sSe, date); sS.forEach(w => {
          trackService(dayS, w.id, sSs, sSe); addR1Service(w, date, sSs, sSe, serverNotes1);
        });
        if (isPast) r1Revenue.push({ restaurantId: r1.id, date, amount: randInt(1200, 2200, rot) * 100, notes: null });
      } else if (day === 4) {
        // Fri (actif): normal lunch, reinforced dinner.
        const kMs = jitter("10:15", 15, rot), kMe = jitter("15:15", 15, rot+1);
        const sMs = jitter("10:15", 15, rot+3), sMe = jitter("15:15", 15, rot+4);
        const kSs = jitter("18:00", 15, rot+6), kSe = jitter("23:00", 15, rot+7);
        const sSs = jitter("18:00", 15, rot+9), sSe = jitter("23:00", 15, rot+10);
        const kM = pickR1(r1Kitchen, 3, rot, dayK, kMs, kMe, date); kM.forEach(w => {
          trackService(dayK, w.id, kMs, kMe); addR1Service(w, date, kMs, kMe, kitchenNotes1);
        });
        const sM = pickR1(r1Servers, 2, rot+2, dayS, sMs, sMe, date); sM.forEach(w => {
          trackService(dayS, w.id, sMs, sMe); addR1Service(w, date, sMs, sMe, serverNotes1);
        });
        const kS = pickR1(r1Kitchen, 3, rot+5, dayK, kSs, kSe, date, new Set(kM.map(w => w.id))); kS.forEach(w => { trackService(dayK, w.id, kSs, kSe); addR1Service(w, date, kSs, kSe, kitchenNotes1); });
        previousKitchenDinnerIds = new Set(kS.map(w => w.id));
        const sS = pickR1(r1Servers, 3, rot+8, dayS, sSs, sSe, date); sS.forEach(w => { trackService(dayS, w.id, sSs, sSe); addR1Service(w, date, sSs, sSe, serverNotes1); });
        if (isPast) r1Revenue.push({ restaurantId: r1.id, date, amount: randInt(3000, 4500, rot) * 100, notes: null });
      } else if (day === 5) {
        // Sat (complet): lunch stays lean; dinner gets the full team.
        const kMs = jitter("10:15", 15, rot), kMe = jitter("15:15", 15, rot+1);
        const sMs = jitter("10:15", 15, rot+3), sMe = jitter("15:15", 15, rot+4);
        const kSs = jitter("18:00", 15, rot+6), kSe = jitter("23:00", 15, rot+7);
        const sSs = jitter("18:00", 15, rot+9), sSe = jitter("23:00", 15, rot+10);
        const kM = pickR1(r1Kitchen, 2, rot, dayK, kMs, kMe, date); kM.forEach(w => {
          trackService(dayK, w.id, kMs, kMe); addR1Service(w, date, kMs, kMe, kitchenNotes1);
        });
        const sM = pickR1(r1Servers, 2, rot+2, dayS, sMs, sMe, date); sM.forEach(w => {
          trackService(dayS, w.id, sMs, sMe); addR1Service(w, date, sMs, sMe, serverNotes1);
        });
        const kS = pickR1(r1Kitchen, 3, rot+5, dayK, kSs, kSe, date, new Set(kM.map(w => w.id))); kS.forEach(w => { trackService(dayK, w.id, kSs, kSe); addR1Service(w, date, kSs, kSe, kitchenNotes1); });
        previousKitchenDinnerIds = new Set(kS.map(w => w.id));
        const sS = pickR1(r1Servers, 3, rot+8, dayS, sSs, sSe, date); sS.forEach(w => { trackService(dayS, w.id, sSs, sSe); addR1Service(w, date, sSs, sSe, serverNotes1); });
        if (isPast) r1Revenue.push({ restaurantId: r1.id, date, amount: randInt(4000, 6500, rot) * 100, notes: null });
      } else if (day === 6) {
        // Sun (brunch midi only): lighter service after the Saturday night rush.
        const kMs = jitter("10:15", 15, rot), kMe = jitter("15:15", 15, rot+1);
        const sMs = jitter("10:15", 15, rot+3), sMe = jitter("15:15", 15, rot+4);
        const kM = pickR1(r1Kitchen, 3, rot, dayK, kMs, kMe, date); kM.forEach(w => addR1Service(w, date, kMs, kMe, kitchenNotes1));
        const sM = pickR1(r1Servers, 4, rot+2, dayS, sMs, sMe, date); sM.forEach(w => addR1Service(w, date, sMs, sMe, serverNotes1));
        previousKitchenDinnerIds = new Set();
        if (isPast) r1Revenue.push({ restaurantId: r1.id, date, amount: randInt(1800, 3000, rot) * 100, notes: null });
      }
    }
  }

  // Dedup overlapping
  const r1Clean = r1AllServices.filter((s, i) => {
    for (let j = 0; j < i; j++) {
      const o = r1AllServices[j];
      if (o.workerId === s.workerId && o.date === s.date && serviceOverlaps(s, o)) return false;
    }
    return true;
  });
  batchInsert(services, r1Clean);
  batchInsert(dailyRevenue, r1Revenue);
  // Publish past weeks only. Current and next week stay empty so the demo shows the fill workflow.
  const r1PublishedMondays = [...new Set(r1Clean.map(s => mondayOf(s.date)))]
    .filter(m => m < currentMondayStr);
  batchInsert(publishedWeeks, r1PublishedMondays.map(m => ({
    restaurantId: r1.id,
    weekDate: m,
    publishedAt: demoPublishedAtForWeek(m),
  })));
  const r1DraftMondays = [...new Set(r1Clean.map(s => mondayOf(s.date)))]
    .filter(m => m > fmtDate(currentMonday));
  console.log(`  ✓ ${r1Clean.length} services, ${r1Revenue.length} revenue entries, ${r1PublishedMondays.length} weeks published, ${r1DraftMondays.length} draft week(s)`);

  // ── Time clocks (R1 — tap-in/out enabled in sync mode; R2 has no lateness seed) ──
  // Keep the Hours demo quiet: no lateness history, only three open tap-ins that
  // demonstrate records needing operational follow-up without flooding the UI.
  const r1Inserted = db.select().from(services).where(eq(services.restaurantId, r1.id)).all();
  const r1Clocks: Array<{ userId: string; restaurantId: string; serviceId: string; tapIn: string; tapOut: string | null; date: string }> = [];
  const openTapCandidates = r1Inserted
    .filter((svc) => svc.date < todayStr)
    .sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime))
    .slice(0, 3);
  for (const svc of openTapCandidates) {
    r1Clocks.push({
      userId: svc.workerId,
      restaurantId: r1.id,
      serviceId: svc.id,
      tapIn: localIsoFromDateMinute(svc.date, toMin(svc.startTime)),
      tapOut: null,
      date: svc.date,
    });
  }
  batchInsert(timeClocks, r1Clocks);
  console.log(`  ✓ ${r1Clocks.length} open tap-in entries, no lateness history`);

  // ── Holidays (R1) ──
  const r1Admin = r1Created[0];
  const sophie = r1Created.find(u => u.name === "Sophie Marceau")!;
  const omar = r1Created.find(u => u.name === "Omar Sy")!;
  const boon = r1Created.find(u => u.name === "Dany Boon")!;
  const cotillard = r1Created.find(u => u.name === "Marion Cotillard")!;
  const audrey = r1Created.find(u => u.name === "Audrey Tautou")!;
  const nwMon = new Date(currentMonday); nwMon.setDate(currentMonday.getDate() + 7);
  const nwWed = new Date(nwMon); nwWed.setDate(nwMon.getDate() + 2);
  const in2w = new Date(currentMonday); in2w.setDate(currentMonday.getDate() + 14);
  const in2wTue = new Date(in2w); in2wTue.setDate(in2w.getDate() + 1);
  const lastW = new Date(currentMonday); lastW.setDate(currentMonday.getDate() - 4);
  const lastWFri = new Date(lastW); lastWFri.setDate(lastW.getDate() + 2);

  const r1HolidayRows: HolidaySeedRow[] = [
    // Simple demo: enough requests to show the review flow, without creating a crisis scenario.
    { workerId: omar.id, restaurantId: r1.id, startDate: fmtDate(nwMon), endDate: fmtDate(nwWed),
      reason: "Congé personnel prévu de longue date.", status: "pending" },
    { workerId: cotillard.id, restaurantId: r1.id, startDate: fmtDate(in2w), endDate: fmtDate(in2wTue),
      reason: "Deux jours de repos pour un événement familial.", status: "pending" },
    // Past approved leave for the history tab.
    { workerId: boon.id, restaurantId: r1.id, startDate: fmtDate(lastW), endDate: fmtDate(lastWFri),
      reason: "Congé validé la semaine dernière.", status: "approved", reviewedBy: r1Admin.id, reviewedAt: fmtDate(lastW) },
  ];
  for (const leave of r1OwnerLeavePlanSeed) {
    const worker = r1Workers.find(w => w.name === leave.worker);
    if (!worker) continue;
    r1HolidayRows.push({
      workerId: worker.id,
      restaurantId: r1.id,
      startDate: leave.start,
      endDate: addDays(leave.start, leave.days - 1),
      reason: "Planification CP assistée — simulation owner CP-SAT, couverture OK.",
      status: "approved",
      source: "admin_proposal",
      reviewedBy: r1Admin.id,
      reviewedAt: leave.start,
    });
  }
  db.insert(holidayRequests).values(r1HolidayRows).run();
  for (const leave of r1HolidayRows.filter(h => h.status === "approved" && !h.medical)) {
    db.delete(services).where(and(
      eq(services.restaurantId, leave.restaurantId),
      eq(services.workerId, leave.workerId),
      gte(services.date, leave.startDate),
      lte(services.date, leave.endDate),
    )).run();
  }
  console.log(`  ✓ ${r1HolidayRows.length} holiday requests (${r1HolidayRows.filter(h => h.status === "approved").length} approved past, 2 pending)`);

  // ── Replacements (R1) — owner-mediated replacement flow (not two-way swaps) ──
  const r1FutureServices = db.select().from(services)
    .where(and(gte(services.date, todayStr), eq(services.restaurantId, r1.id))).all();
  const r1ReplacementData: Array<{ reqId: string; tgtId: string; msg: string; status: "awaiting_admin_decision" | "awaiting_worker_reply" | "accepted" }> = [
    { reqId: boon.id, tgtId: omar.id, msg: "Indisponibilité personnelle, je dois être remplacé sur ce service.", status: "awaiting_admin_decision" },
  ];
  let r1ReplacementCount = 0;
  for (const sw of r1ReplacementData) {
    const service = r1FutureServices.find(s => s.workerId === sw.reqId);
    if (!service) continue;
    const workerNotifiedAt = sw.status === "awaiting_admin_decision" ? null : new Date();
    const expiresAt = replacementReplyExpiresAt(workerNotifiedAt ?? new Date());
    const isResolved = sw.status === "accepted";
    db.insert(replacementRequests).values({
      requesterId: sw.reqId,
      requesterServiceId: service.id,
      targetId: sw.status === "awaiting_admin_decision" ? null : sw.tgtId,
      restaurantId: r1.id,
      status: sw.status,
      message: sw.msg,
      expiresAt,
      respondedAt: isResolved ? new Date().toISOString() : null,
      adminNotifiedAt: new Date().toISOString(),
      workerNotifiedAt: workerNotifiedAt?.toISOString() ?? null,
      candidateIds: [sw.tgtId],
    }).run();
    r1ReplacementCount++;
  }
  console.log(`  ✓ ${r1ReplacementCount} replacement requests`);

  // ── Restaurant 1B — same owner as Chez Reno, used for multi-restaurant demos ──
  const [r1b] = db.insert(restaurants).values({
    ownerId: r1Owner.id,
    name: "La Civette",
    address: "18 Rue de Charonne, 75011 Paris",
    timezone: "Europe/Paris",
    status: "demo",
    onboardingCompletedAt: new Date().toISOString(),
    colorScheme: "garden",
    kitchenColor: "emerald",
    floorColor: "rose",
    defaultContractType: DEFAULT_CONTRACT_TYPE,
    defaultContractHours: DEFAULT_CONTRACT_HOURS,
    workerPreferencesEnabled: true,
    tapInOutEnabled: false,
    tapInOutMode: "lateness_only",
    medicalMode: false,
    reminderFrequency: "off",
    autoStaffingWeeks: 3,
    disabledComplianceRules: JSON.stringify(["HCR-L3121-16"]),
    preferredStyle: "equipe-stable",
    overtimeMode: "flexible",
    kitchenSubRoles: '["Chef","Cuisinier","Commis"]',
    floorSubRoles: '["Chef de rang","Serveur"]',
    subroleHcrMap: "{}",
    openDays: JSON.stringify({"2":"both","3":"both","4":"both","5":"both","6":"both"}),
  }).returning().all();

  const r1bGeo = await geocodeAddress(r1b.address!);
  if (r1bGeo) {
    const r1bZones = detectZones(r1b.address!);
    db.update(restaurants).set({
      latitude: Math.round(r1bGeo.lat * 1e6),
      longitude: Math.round(r1bGeo.lon * 1e6),
      ...(r1bZones ?? {}),
    }).where(eq(restaurants.id, r1b.id)).run();
    console.log(`  ✓ Restaurant 1B: ${r1b.name} (same owner) — geocoded: ${r1bGeo.lat.toFixed(4)}, ${r1bGeo.lon.toFixed(4)}`);
  } else {
    console.log(`  ✓ Restaurant 1B: ${r1b.name} (same owner) — geocoding failed, no weather/calendar`);
  }

  rawDb.run(
    "INSERT OR IGNORE INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)",
    [r1b.id, r1Admin.id, "admin", r1Admin.permissions ?? null, 1],
  );
  rawDb.run(
    "INSERT OR IGNORE INTO restaurant_memberships (restaurant_id, user_id, role, permissions, active) VALUES (?, ?, ?, ?, ?)",
    [r1b.id, sophie.id, "manager", sophie.permissions ?? null, 1],
  );

  const sharedIntoLaCivette = [
    { worker: audrey, role: "kitchen" as const, priority: 1, subRoles: '["Cuisinier","Commis"]' },
    { worker: omar, role: "floor" as const, priority: 1, subRoles: '["Chef de rang","Serveur"]' },
    { worker: cotillard, role: "floor" as const, priority: 2, subRoles: '["Serveur"]' },
  ];
  batchInsert(workerRestaurantProfiles, sharedIntoLaCivette.map(({ worker, priority, subRoles }) => ({
    restaurantId: r1b.id,
    userId: worker.id,
    priority,
    subRoles,
    contractType: contractData[worker.name]?.type ?? null,
    contractHours: contractData[worker.name]?.hours ?? DEFAULT_CONTRACT_HOURS,
    maxWeeklyHours: 48,
    multiRestaurantWilling: true,
  })));
  batchInsert(workerShareAuthorizations, sharedIntoLaCivette.map(({ worker, role }) => ({
    ownerId: r1Owner.id,
    sourceRestaurantId: r1.id,
    targetRestaurantId: r1b.id,
    userId: worker.id,
    role,
    status: "accepted" as const,
    invitedByUserId: r1Admin.id,
    workerConsentedAt: new Date().toISOString(),
    revokedAt: null,
  })));

  const [r1bProfile] = db.insert(staffingProfiles)
    .values({ restaurantId: r1b.id, name: "", sortOrder: 0 })
    .returning({ id: staffingProfiles.id }).all();
  db.insert(serviceTemplates).values([
    { restaurantId: r1b.id, profileId: r1bProfile.id, role: "kitchen", zone: "MIDI", startTime: "10:00", endTime: "15:00", sortOrder: 1 },
    { restaurantId: r1b.id, profileId: r1bProfile.id, role: "floor", zone: "MIDI", startTime: "11:00", endTime: "15:00", sortOrder: 1 },
    { restaurantId: r1b.id, profileId: r1bProfile.id, role: "kitchen", zone: "SOIR", startTime: "18:00", endTime: "23:00", sortOrder: 2 },
    { restaurantId: r1b.id, profileId: r1bProfile.id, role: "floor", zone: "SOIR", startTime: "18:00", endTime: "23:00", sortOrder: 2 },
  ]).run();
  const r1bTargets = [2, 3, 4, 5, 6].flatMap(day => [
    { day, role: "kitchen" as const, zone: "MIDI", count: 1 },
    { day, role: "floor" as const, zone: "MIDI", count: 1 },
    { day, role: "kitchen" as const, zone: "SOIR", count: 1 },
    { day, role: "floor" as const, zone: "SOIR", count: 2 },
  ]);
  db.insert(staffingTargets).values(
    r1bTargets.map(t => ({ restaurantId: r1b.id, profileId: r1bProfile.id, dayOfWeek: t.day, role: t.role, zone: t.zone, count: t.count }))
  ).run();
  db.insert(staffingSchedule).values(r1SchedRows.map(row => ({
    restaurantId: r1b.id,
    profileId: r1bProfile.id,
    year: row.year,
    week: row.week,
  }))).run();

  const analyticWednesday = addDays(currentMondayStr, -5);
  const analyticFriday = addDays(currentMondayStr, -3);
  const laCivetteServices: Service[] = [
    { workerId: audrey.id, restaurantId: r1b.id, date: analyticWednesday, startTime: "10:00", endTime: "15:00", role: "kitchen", notes: "Service partagé — analytique La Civette" },
    { workerId: omar.id, restaurantId: r1b.id, date: analyticWednesday, startTime: "11:00", endTime: "15:00", role: "floor", notes: "Service partagé — analytique La Civette" },
    { workerId: omar.id, restaurantId: r1b.id, date: analyticFriday, startTime: "18:00", endTime: "23:00", role: "floor", notes: "Service partagé — analytique La Civette" },
    { workerId: cotillard.id, restaurantId: r1b.id, date: analyticFriday, startTime: "18:00", endTime: "23:00", role: "floor", notes: "Service partagé — analytique La Civette" },
  ];
  batchInsert(services, laCivetteServices);
  batchInsert(dailyRevenue, [
    { restaurantId: r1b.id, date: analyticWednesday, amount: 215000, notes: "Démo multi-restaurant" },
    { restaurantId: r1b.id, date: analyticFriday, amount: 385000, notes: "Démo multi-restaurant" },
  ]);
  batchInsert(publishedWeeks, [{
    restaurantId: r1b.id,
    weekDate: mondayOf(analyticWednesday),
    publishedAt: demoPublishedAtForWeek(mondayOf(analyticWednesday)),
  }]);
  console.log(`  ✓ ${sharedIntoLaCivette.length} workers shared from Chez Reno to La Civette, ${laCivetteServices.length} analytic services`);

  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // RESTAURANT 2 — COMPLEX: "The Grand Brasserie" (40 operational workers)
  // ════════════════════════════════════════════════════════════════════════════

  const r2Owner = createDemoOwner("The Grand Brasserie");
  const [r2] = db.insert(restaurants).values({
    ownerId: r2Owner.id,
    name: "The Grand Brasserie",
    address: "8 Place de la Concorde, 75008 Paris",
    timezone: "Europe/Paris",
    status: "demo",
    onboardingCompletedAt: new Date().toISOString(),
    colorScheme: "ocean",
    kitchenColor: "teal",
    floorColor: "amber",
    defaultContractType: DEFAULT_CONTRACT_TYPE,
    defaultContractHours: DEFAULT_CONTRACT_HOURS,
    workerPreferencesEnabled: true,
    tapInOutEnabled: true,
    tapInOutMode: "lateness_only",
    medicalMode: true,
    reminderFrequency: "off",
    autoStaffingWeeks: 3,
    disabledComplianceRules: JSON.stringify(["HCR-L3121-16"]),
    preferredStyle: "equipe-stable",
    overtimeMode: "controlled",
    overtimeWeeklyCap: 44,
    overtimeDistribution: "willing-first",
    openDays: JSON.stringify({"2":"both","3":"both","4":"both","5":"both","6":"both","7":"both"}),
  }).returning().all();

  const r2Geo = await geocodeAddress(r2.address!);
  if (r2Geo) {
    const r2Zones = detectZones(r2.address!);
    db.update(restaurants).set({
      latitude: Math.round(r2Geo.lat * 1e6),
      longitude: Math.round(r2Geo.lon * 1e6),
      ...(r2Zones ?? {}),
    }).where(eq(restaurants.id, r2.id)).run();
    console.log(`  ✓ Restaurant 2: ${r2.name} (Complex) — geocoded: ${r2Geo.lat.toFixed(4)}, ${r2Geo.lon.toFixed(4)}`);
  } else {
    console.log(`  ✓ Restaurant 2: ${r2.name} (Complex) — geocoding failed, no weather/calendar`);
  }

  // ── Users: American actors (21 kitchen + 21 salle + admin/manager) ──
  type R2WorkerSeed = {
    name: string;
    email: string;
    phone: string;
    role: "kitchen" | "floor";
    priority: number;
    subRoles: string;
    contractType: "CDI" | "CDD" | "saisonnier";
    contractHours: number;
    contractEndDate?: string;
    startDate?: string;
    notes: string;
    managerNotes: string;
  };
  const r2KitchenSeed: R2WorkerSeed[] = [
    { name: "Robert De Niro", email: "deniro@grandbrasserie.fr", phone: "+33600200002", role: "kitchen", priority: 1, subRoles: '["Chef"]', contractType: "CDI", contractHours: 39, notes: "Chef historique. Sa brigade avance au regard.", managerNotes: "Pilier coupure. Excellent pour stabiliser les semaines tendues." },
    { name: "Al Pacino", email: "pacino@grandbrasserie.fr", phone: "+33600200003", role: "kitchen", priority: 1, subRoles: '["Chef","Sous-chef","Cuisinier"]', contractType: "CDI", contractHours: 39, notes: "Énergie de coup de feu permanente. HOO-AH inclus.", managerNotes: "Accepte volontiers les grosses semaines." },
    { name: "Meryl Streep", email: "streep@grandbrasserie.fr", phone: "+33600200004", role: "kitchen", priority: 1, subRoles: '["Chef","Sous-chef","Cuisinier"]', contractType: "CDI", contractHours: 39, notes: "Polyvalente et précise, passe du chaud au garde-manger sans friction.", managerNotes: "Peut couvrir chef ou sous-chef en urgence." },
    { name: "Denzel Washington", email: "washington@grandbrasserie.fr", phone: "+33600200008", role: "kitchen", priority: 1, subRoles: '["Chef","Cuisinier"]', contractType: "CDI", contractHours: 39, notes: "Discipline calme, poste impeccable.", managerNotes: "Bon profil coupure quand les chefs sont absents." },
    { name: "Samuel L. Jackson", email: "jackson@grandbrasserie.fr", phone: "+33600200006", role: "kitchen", priority: 1, subRoles: '["Sous-chef","Cuisinier"]', contractType: "CDI", contractHours: 39, notes: "Expéditeur en chef. Personne ne traîne quand Samuel annonce les plats.", managerNotes: "Très fiable sur les soirs chargés." },
    { name: "Viola Davis", email: "davis@grandbrasserie.fr", phone: "+33600200028", role: "kitchen", priority: 1, subRoles: '["Sous-chef","Cuisinier"]', contractType: "CDI", contractHours: 39, notes: "Organisation nette, pédagogie forte avec les commis.", managerNotes: "Excellent relais de management cuisine." },
    { name: "Frances McDormand", email: "mcdormand@grandbrasserie.fr", phone: "+33600200029", role: "kitchen", priority: 1, subRoles: '["Sous-chef","Cuisinier"]', contractType: "CDI", contractHours: 35, notes: "Peu de mots, beaucoup d'impact.", managerNotes: "Matin très solide, accepte quelques coupures." },
    { name: "Jack Nicholson", email: "nicholson@grandbrasserie.fr", phone: "+33600200005", role: "kitchen", priority: 1, subRoles: '["Cuisinier"]', contractType: "CDI", contractHours: 35, notes: "Créatif au chaud, sourire inquiétant quand le service accélère.", managerNotes: "Mieux en soirée qu'en ouverture." },
    { name: "Scarlett Johansson", email: "johansson@grandbrasserie.fr", phone: "+33600200007", role: "kitchen", priority: 1, subRoles: '["Cuisinier"]', contractType: "CDI", contractHours: 35, notes: "Polyvalente, rapide, très bonne sur les préparations du matin.", managerNotes: "Préférence matin." },
    { name: "Natalie Portman", email: "portman@grandbrasserie.fr", phone: "+33600200030", role: "kitchen", priority: 1, subRoles: '["Cuisinier"]', contractType: "CDI", contractHours: 35, notes: "Méticuleuse au garde-manger, dressage régulier.", managerNotes: "Matin régulier." },
    { name: "Emma Stone", email: "stone@grandbrasserie.fr", phone: "+33600200031", role: "kitchen", priority: 1, subRoles: '["Cuisinier"]', contractType: "CDI", contractHours: 35, notes: "Très vive pendant les changements de rythme.", managerNotes: "Bonne bascule midi/soir." },
    { name: "Mahershala Ali", email: "ali@grandbrasserie.fr", phone: "+33600200032", role: "kitchen", priority: 1, subRoles: '["Cuisinier"]', contractType: "CDI", contractHours: 35, notes: "Calme et propre au poste poisson.", managerNotes: "Soir fiable." },
    { name: "Jamie Foxx", email: "foxx@grandbrasserie.fr", phone: "+33600200033", role: "kitchen", priority: 2, subRoles: '["Cuisinier","Plongeur"]', contractType: "CDI", contractHours: 35, notes: "Aide partout, surtout quand la plonge déborde.", managerNotes: "Profil tampon." },
    { name: "Anthony Hopkins", email: "anthony.hopkins@demo.com", phone: "+33600200034", role: "kitchen", priority: 2, subRoles: '["Cuisinier","Plongeur"]', contractType: "CDI", contractHours: 35, notes: "Méthodique et silencieux, très sûr sur les longues séries.", managerNotes: "Très bon sur le soir." },
    { name: "Cate Blanchett", email: "blanchett@grandbrasserie.fr", phone: "+33600200011", role: "kitchen", priority: 2, subRoles: '["Cuisinier","Plongeur"]', contractType: "CDI", contractHours: 35, notes: "Dressage précis, prend soin des détails.", managerNotes: "Peut couvrir midi ou soir." },
    { name: "Octavia Spencer", email: "spencer@grandbrasserie.fr", phone: "+33600200035", role: "kitchen", priority: 2, subRoles: '["Commis","Plongeur"]', contractType: "CDI", contractHours: 35, notes: "Commis fiable, très bonne préparation froide.", managerNotes: "À faire monter progressivement." },
    { name: "Keanu Reeves", email: "reeves@grandbrasserie.fr", phone: "+33600200010", role: "kitchen", priority: 3, subRoles: '["Plongeur","Commis"]', contractType: "CDD", contractHours: 20, contractEndDate: "2026-07-15", notes: "Renfort plonge fiable sur les gros services.", managerNotes: "CDD court 20h — renfort ciblé." },
    { name: "Brie Larson", email: "larson@grandbrasserie.fr", phone: "+33600200036", role: "kitchen", priority: 3, subRoles: '["Commis","Plongeur"]', contractType: "CDD", contractHours: 18, contractEndDate: "2026-08-31", notes: "Renfort préparation, disponible surtout le matin.", managerNotes: "CDD 18h." },
    { name: "Michael B. Jordan", email: "jordan@grandbrasserie.fr", phone: "+33600200037", role: "kitchen", priority: 3, subRoles: '["Cuisinier","Commis"]', contractType: "CDD", contractHours: 16, contractEndDate: "2026-09-30", notes: "Renfort chaud du week-end.", managerNotes: "CDD 16h, utile vendredi/samedi." },
    { name: "Zendaya Coleman", email: "zendaya@grandbrasserie.fr", phone: "+33600200038", role: "kitchen", priority: 4, subRoles: '["Commis"]', contractType: "CDD", contractHours: 12, contractEndDate: "2026-09-30", notes: "Extra préparation, rapide à former.", managerNotes: "Petit contrat, ne pas surcharger." },
    { name: "Michelle Yeoh", email: "yeoh@grandbrasserie.fr", phone: "+33600200049", role: "kitchen", priority: 2, subRoles: '["Sous-chef","Cuisinier","Commis"]', contractType: "CDD", contractHours: 28, contractEndDate: "2026-10-31", startDate: "2026-02-02", notes: "Renfort saisonnier polyvalent arrivé pour absorber les congés de printemps.", managerNotes: "CDD 28h, très utile pour libérer les anciens sans fragiliser la cuisine." },
  ];
  const r2FloorSeed: R2WorkerSeed[] = [
    { name: "Tom Hanks", email: "hanks@grandbrasserie.fr", phone: "+33600200012", role: "floor", priority: 1, subRoles: '["Chef de rang"]', contractType: "CDI", contractHours: 39, notes: "Le chef de rang que tout le monde suit naturellement.", managerNotes: "Coupure stable." },
    { name: "Brad Pitt", email: "pitt@grandbrasserie.fr", phone: "+33600200013", role: "floor", priority: 1, subRoles: '["Chef de rang","Serveur"]', contractType: "CDI", contractHours: 39, notes: "Ventes additionnelles record, surtout sur la carte des vins.", managerNotes: "Très fort le soir." },
    { name: "Angelina Jolie", email: "jolie@grandbrasserie.fr", phone: "+33600200014", role: "floor", priority: 1, subRoles: '["Chef de rang","Sous-chef de rang","Serveur"]', contractType: "CDI", contractHours: 39, notes: "Gère les VIP et les événements spéciaux.", managerNotes: "Peut porter une coupure." },
    { name: "Leonardo DiCaprio", email: "dicaprio@grandbrasserie.fr", phone: "+33600200015", role: "floor", priority: 1, subRoles: '["Chef de rang","Serveur"]', contractType: "CDI", contractHours: 39, notes: "Très bon relationnel, discours produit impeccable.", managerNotes: "Matin et déjeuner solides." },
    { name: "Ryan Gosling", email: "gosling@grandbrasserie.fr", phone: "+33600200017", role: "floor", priority: 1, subRoles: '["Chef de rang","Sous-chef de rang","Serveur"]', contractType: "CDI", contractHours: 39, notes: "Service silencieux et efficace.", managerNotes: "Soir préféré." },
    { name: "Anne Hathaway", email: "hathaway@grandbrasserie.fr", phone: "+33600200020", role: "floor", priority: 1, subRoles: '["Chef de rang","Sous-chef de rang","Serveur"]', contractType: "CDI", contractHours: 35, notes: "Précise et organisée, formatrice naturelle.", managerNotes: "Matin régulier." },
    { name: "Joaquin Phoenix", email: "phoenix@grandbrasserie.fr", phone: "+33600200023", role: "floor", priority: 1, subRoles: '["Barman","Serveur"]', contractType: "CDI", contractHours: 39, notes: "Intense au bar, très bon avec les clients exigeants.", managerNotes: "Soir bar." },
    { name: "Matt Damon", email: "damon@grandbrasserie.fr", phone: "+33600200025", role: "floor", priority: 1, subRoles: '["Barman","Serveur"]', contractType: "CDI", contractHours: 39, notes: "Solide et sans surprise.", managerNotes: "Zéro plainte client en six mois." },
    { name: "Sandra Bullock", email: "bullock@grandbrasserie.fr", phone: "+33600200026", role: "floor", priority: 1, subRoles: '["Barman","Serveur"]', contractType: "CDI", contractHours: 35, notes: "Gère le stress avec humour.", managerNotes: "Très utile pendant les rushs." },
    { name: "Julia Roberts", email: "roberts@grandbrasserie.fr", phone: "+33600200039", role: "floor", priority: 1, subRoles: '["Serveur"]', contractType: "CDI", contractHours: 35, notes: "Sourire naturel, excellente fidélisation client.", managerNotes: "Matin et midi." },
    { name: "Jennifer Lawrence", email: "lawrence@grandbrasserie.fr", phone: "+33600200040", role: "floor", priority: 1, subRoles: '["Serveur"]', contractType: "CDI", contractHours: 35, notes: "Énergie contagieuse en salle.", managerNotes: "Polyvalente midi/soir." },
    { name: "Amy Adams", email: "adams@grandbrasserie.fr", phone: "+33600200041", role: "floor", priority: 1, subRoles: '["Serveur"]', contractType: "CDI", contractHours: 35, notes: "Très attentive aux détails de service.", managerNotes: "Ouverture fiable." },
    { name: "Jessica Chastain", email: "chastain@grandbrasserie.fr", phone: "+33600200042", role: "floor", priority: 1, subRoles: '["Serveur"]', contractType: "CDI", contractHours: 35, notes: "Carrée sur les standards de salle.", managerNotes: "Bonne sur les services longs." },
    { name: "Chris Evans", email: "evans@grandbrasserie.fr", phone: "+33600200043", role: "floor", priority: 2, subRoles: '["Runner","Serveur"]', contractType: "CDI", contractHours: 35, notes: "Runner rapide, tient la pression.", managerNotes: "Bon renfort soir." },
    { name: "Chris Hemsworth", email: "hemsworth@grandbrasserie.fr", phone: "+33600200044", role: "floor", priority: 2, subRoles: '["Runner","Serveur"]', contractType: "CDI", contractHours: 35, notes: "Très bon soutien plateau.", managerNotes: "Week-end fiable." },
    { name: "Mark Ruffalo", email: "ruffalo@grandbrasserie.fr", phone: "+33600200045", role: "floor", priority: 2, subRoles: '["Runner","Serveur"]', contractType: "CDI", contractHours: 35, notes: "Discret et efficace en soutien.", managerNotes: "Matin/midi." },
    { name: "Dwayne Johnson", email: "johnson@grandbrasserie.fr", phone: "+33600200027", role: "floor", priority: 3, subRoles: '["Barman","Runner"]', contractType: "CDD", contractHours: 20, contractEndDate: "2026-09-30", notes: "Renfort bar du week-end.", managerNotes: "CDD 20h — renfort ciblé vendredi/samedi." },
    { name: "Gal Gadot", email: "gadot@grandbrasserie.fr", phone: "+33600200046", role: "floor", priority: 3, subRoles: '["Serveur","Runner"]', contractType: "CDD", contractHours: 18, contractEndDate: "2026-08-31", notes: "Extra salle souriante, surtout le soir.", managerNotes: "CDD 18h." },
    { name: "Margot Robbie", email: "robbie@grandbrasserie.fr", phone: "+33600200047", role: "floor", priority: 3, subRoles: '["Serveur"]', contractType: "CDD", contractHours: 16, contractEndDate: "2026-09-30", notes: "Renfort terrasse et limonade.", managerNotes: "CDD 16h, week-end." },
    { name: "Timothee Chalamet", email: "chalamet@grandbrasserie.fr", phone: "+33600200048", role: "floor", priority: 4, subRoles: '["Runner"]', contractType: "CDD", contractHours: 10, contractEndDate: "2026-07-31", notes: "Petit contrat runner, utile sur les pics.", managerNotes: "Ne pas planifier au-delà de 10h sans arbitrage." },
    { name: "Idris Elba", email: "elba@grandbrasserie.fr", phone: "+33600200050", role: "floor", priority: 2, subRoles: '["Chef de rang","Barman","Serveur"]', contractType: "CDD", contractHours: 28, contractEndDate: "2026-10-31", startDate: "2026-02-02", notes: "Renfort saisonnier salle/bar pour garder de la marge pendant les congés.", managerNotes: "CDD 28h, bon relais chef de rang et bar." },
  ];
  const r2UserSeed = [
    // Admin
    { name: "Morgan Freeman", email: "freeman@grandbrasserie.fr", phone: "+33600200001", role: "admin" as const, priority: 1,
      subRoles: "[]", contractType: null as "CDI" | "CDD" | "saisonnier" | null, contractHours: null as number | null,
      notes: "Le gérant. Sa voix calme suffit à résoudre n'importe quel conflit en salle.", managerNotes: null },
    // Manager (Responsable) — assistant gérant, off-schedule
    { name: "Sigourney Weaver", email: "weaver@grandbrasserie.fr", phone: "+33600200099", role: "manager" as const, priority: 1,
      subRoles: "[]", contractType: "CDI" as "CDI" | "CDD" | "saisonnier" | null, contractHours: 39 as number | null,
      notes: "Responsable de salle. Fait tourner la brasserie quand Morgan voyage.", managerNotes: "Discrète mais redoutable. Les fournisseurs la respectent." },
    ...r2KitchenSeed,
    ...r2FloorSeed,
  ];

  const r2Created = db.insert(users).values(
    r2UserSeed.map(u => ({
      ...u, passwordHash: pw, restaurantId: r2.id, address: null, iban: null, managerNotes: u.managerNotes,
      startDate: u.role === "admin" || u.role === "manager" ? null : "startDate" in u ? u.startDate : "2025-01-01",
      subRoles: u.subRoles, contractType: u.contractType as "CDI" | "CDD" | "saisonnier" | null, contractHours: u.contractHours,
      multiRestaurantWilling: u.role === "kitchen" || u.role === "floor",
    }))
  ).returning().all();

  r2Created.forEach(u => console.log(`    ${u.role === "admin" ? "👑" : u.role === "manager" ? "🎩" : u.role === "kitchen" ? "🍳" : "🍽️ "} ${u.name}`));

  // Realistic compensation (HCR level + hourly rate) + OT-willing + priority variance for R2
  applyRealisticComp(r2Created, fmtDate(currentMonday));
  seedMembershipsAndProfiles(r2Owner.id, r2.id, r2Created.map((user) => user.id));
  console.log("  ✓ Compensation + OT-willing + priority (HCR-based)");

  // ── 1 staffing profile: Standard (RoleBased) with roleBreakdown targets ──
  const [r2Profile] = db.insert(staffingProfiles).values({
    restaurantId: r2.id,
    name: "Standard (RoleBased)",
    sortOrder: 0,
    dayPriorities: JSON.stringify({"3":1,"6":1,"7":1}),
  }).returning({ id: staffingProfiles.id }).all();
  const r2Profiles = [r2Profile]; // keep array for schedule assignment compatibility

  // Service templates for the profile
  const r2ProfTemplates = db.insert(serviceTemplates).values([
    { restaurantId: r2.id, profileId: r2Profile.id, role: "kitchen", zone: "Midi",    startTime: "08:00", endTime: "16:00", sortOrder: 1 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "floor",   zone: "Midi",    startTime: "08:00", endTime: "16:00", sortOrder: 1 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "kitchen", zone: "Soir",    startTime: "16:00", endTime: "00:00", sortOrder: 2 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "floor",   zone: "Soir",    startTime: "16:00", endTime: "00:00", sortOrder: 2 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "kitchen", zone: "Coupure", startTime: "09:30", endTime: "15:00", sortOrder: 3 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "kitchen", zone: "Coupure", startTime: "17:00", endTime: "22:30", sortOrder: 3 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "floor",   zone: "Coupure", startTime: "09:30", endTime: "15:15", sortOrder: 3 },
    { restaurantId: r2.id, profileId: r2Profile.id, role: "floor",   zone: "Coupure", startTime: "16:45", endTime: "22:30", sortOrder: 3 },
  ]).returning().all();
  console.log("  ✓ Service templates: Midi + Soir + Coupure (profile)");

  // Sunday overrides on Midi templates
  const profMidiKitchen = r2ProfTemplates.find(t => t.role === "kitchen" && t.zone === "Midi")!;
  const profMidiSalle = r2ProfTemplates.find(t => t.role === "floor" && t.zone === "Midi")!;
  db.insert(serviceTemplateOverrides).values([
    { templateId: profMidiKitchen.id, dayOfWeek: 7, startTime: "08:15", endTime: "16:15" },
    { templateId: profMidiSalle.id, dayOfWeek: 7, startTime: "08:30", endTime: "16:30" },
  ]).run();
  console.log("  ✓ Sunday overrides on Midi templates");

  // Staffing targets with roleBreakdown — all-day brasserie with near-full
  // contract absorption. Extra demand is added on Midi/Soir, not Coupure, so
  // the demo fills contracts without mechanically overloading split-shift leads.
  type R2Target = { day: number; role: "kitchen" | "floor"; zone: string; count: number; rb: Record<string, number> };
  const r2Targets: R2Target[] = [];
  for (const d of [2, 3, 4]) {
    r2Targets.push(
      { day: d, role: "kitchen", zone: "Coupure", count: 2, rb: {"Chef":1,"Sous-chef":1} },
      { day: d, role: "kitchen", zone: "Midi",    count: 5, rb: {"Cuisinier":3,"Commis":1,"Plongeur":1} },
      { day: d, role: "kitchen", zone: "Soir",    count: 6, rb: {"Sous-chef":1,"Cuisinier":4,"Plongeur":1} },
      { day: d, role: "floor", zone: "Coupure", count: 2, rb: {"Chef de rang":2} },
      { day: d, role: "floor", zone: "Midi",    count: 5, rb: {"Serveur":3,"Runner":1,"Barman":1} },
      { day: d, role: "floor", zone: "Soir",    count: 5, rb: {"Chef de rang":1,"Serveur":2,"Runner":1,"Barman":1} },
    );
  }
  for (const d of [5, 6]) {
    r2Targets.push(
      { day: d, role: "kitchen", zone: "Coupure", count: 2, rb: {"Chef":1,"Sous-chef":1} },
      { day: d, role: "kitchen", zone: "Midi",    count: 7, rb: {"Cuisinier":5,"Commis":1,"Plongeur":1} },
      { day: d, role: "kitchen", zone: "Soir",    count: 6, rb: {"Sous-chef":1,"Cuisinier":4,"Plongeur":1} },
      { day: d, role: "floor", zone: "Coupure", count: 2, rb: {"Chef de rang":1,"Sous-chef de rang":1} },
      { day: d, role: "floor", zone: "Midi",    count: 7, rb: {"Chef de rang":1,"Serveur":4,"Runner":1,"Barman":1} },
      { day: d, role: "floor", zone: "Soir",    count: 7, rb: {"Chef de rang":1,"Serveur":4,"Runner":1,"Barman":1} },
    );
  }
  for (const d of [7]) {
    r2Targets.push(
      { day: d, role: "kitchen", zone: "Coupure", count: 2, rb: {"Chef":1,"Sous-chef":1} },
      { day: d, role: "kitchen", zone: "Midi",    count: 5, rb: {"Cuisinier":3,"Commis":1,"Plongeur":1} },
      { day: d, role: "kitchen", zone: "Soir",    count: 4, rb: {"Sous-chef":1,"Cuisinier":2,"Plongeur":1} },
      { day: d, role: "floor", zone: "Coupure", count: 2, rb: {"Chef de rang":2} },
      { day: d, role: "floor", zone: "Midi",    count: 5, rb: {"Serveur":3,"Runner":1,"Barman":1} },
      { day: d, role: "floor", zone: "Soir",    count: 5, rb: {"Chef de rang":1,"Serveur":2,"Runner":1,"Barman":1} },
    );
  }
  db.insert(staffingTargets).values(
    r2Targets.map(t => ({
      restaurantId: r2.id, profileId: r2Profile.id, dayOfWeek: t.day, role: t.role, zone: t.zone, count: t.count,
      roleBreakdown: JSON.stringify(t.rb),
    }))
  ).run();
  console.log(`  ✓ 1 staffing profile: Standard (RoleBased) with ${r2Targets.length} targets`);

  // ── Titulaires: pre-pin the stable brigade so /objectif/:id/titulaires is populated ──
  const hasSubRole = (u: typeof r2Created[0], role: string) => {
    try { return JSON.parse(u.subRoles || "[]").includes(role); } catch { return false; }
  };
  const r2PreferredAssignments: Array<{ workerId: string; dayOfWeek: number; zone: string; role: "kitchen" | "floor"; subRole: string }> = [];
  const r2PinCursors = new Map<string, number>();
  const r2UsedPins = new Map<string, Set<string>>();
  const r2WorkersWithSubRole = (role: "kitchen" | "floor", subRole: string) =>
    r2Created.filter(u => u.role === role && hasSubRole(u, subRole));
  const r2PickPinnedWorker = (dayOfWeek: number, role: "kitchen" | "floor", subRole: string) => {
    const exactPool = r2WorkersWithSubRole(role, subRole);
    const fallbackPool = r2Created.filter(u => u.role === role);
    const pool = exactPool.length > 0 ? exactPool : fallbackPool;
    const usedKey = `${dayOfWeek}_${role}`;
    if (!r2UsedPins.has(usedKey)) r2UsedPins.set(usedKey, new Set());
    const used = r2UsedPins.get(usedKey)!;
    const cursorKey = `${role}_${subRole}`;
    const start = r2PinCursors.get(cursorKey) ?? 0;
    for (let offset = 0; offset < pool.length; offset++) {
      const idx = (start + offset) % pool.length;
      const worker = pool[idx];
      if (used.has(worker.id)) continue;
      r2PinCursors.set(cursorKey, idx + 1);
      used.add(worker.id);
      return worker;
    }
    const worker = pool[start % pool.length];
    r2PinCursors.set(cursorKey, start + 1);
    return worker;
  };
  for (const target of r2Targets) {
    for (const [subRole, count] of Object.entries(target.rb)) {
      for (let i = 0; i < count; i++) {
        const worker = r2PickPinnedWorker(target.day, target.role, subRole);
        r2PreferredAssignments.push({ workerId: worker.id, dayOfWeek: target.day, zone: target.zone, role: target.role, subRole });
      }
    }
  }
  db.update(staffingProfiles).set({ preferredAssignments: JSON.stringify(r2PreferredAssignments) }).where(eq(staffingProfiles.id, r2Profile.id)).run();
  console.log(`  ✓ Titulaires (${r2PreferredAssignments.length} assignments)`);

  // ── Staffing schedule (assign profiles to weeks) ──
  // All seeded weeks use the same all-day profile so the complex demo stays consistent.
  const isoWeek = (d: Date): { year: number; week: number } => {
    const tmp = new Date(d.getTime());
    tmp.setHours(0, 0, 0, 0);
    tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
    const jan4 = new Date(tmp.getFullYear(), 0, 4);
    const week = 1 + Math.round(((tmp.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return { year: tmp.getFullYear(), week };
  };
  const schedRows: { restaurantId: string; profileId: string; year: number; week: number }[] = [];
  for (let w = -DEMO_HISTORY_WEEKS; w <= DEMO_FUTURE_SERVICE_WEEKS; w++) {
    const d = new Date(currentMonday); d.setDate(currentMonday.getDate() + w * 7);
    const iw = isoWeek(d);
    schedRows.push({ restaurantId: r2.id, profileId: r2Profiles[0].id, year: iw.year, week: iw.week });
  }
  db.insert(staffingSchedule).values(schedRows).run();
  console.log(`  ✓ ${schedRows.length} weeks in staffing schedule`);

  // ── Worker restrictions (R2) — 10 restrictions matching live data ──
  const r2Workers = r2Created.filter(u => u.role !== "admin" && u.role !== "manager");
  const r2Kitchen = r2Created.filter(u => u.role === "kitchen");
  const r2Servers = r2Created.filter(u => u.role === "floor");
  // Sub-role filtered pools for Coupure (Chef / Chef de rang required)
  const r2KitchenChefs = r2Kitchen.filter(u => hasSubRole(u, "Chef"));
  const r2SalleChefDeRang = r2Servers.filter(u => hasSubRole(u, "Chef de rang"));

  // Direct restriction definitions matching current live state
  const r2RestrDefs: Array<{ name: string; day: number; start: string | null; end: string | null; reason: string }> = [
    { name: "Al Pacino",          day: 5, start: "06:00", end: "16:00", reason: "Indisponible le matin/midi" },
    { name: "Brad Pitt",           day: 6, start: "07:00", end: "16:30", reason: "Indisponible le matin/midi" },
    { name: "Ryan Gosling",        day: 4, start: "07:00", end: "16:30", reason: "Indisponible le matin/midi" },
    { name: "Ryan Gosling",        day: 5, start: "07:00", end: "16:30", reason: "Indisponible le matin/midi" },
    { name: "Ryan Gosling",        day: 6, start: "07:00", end: "16:30", reason: "Indisponible le matin/midi" },
    { name: "Scarlett Johansson",  day: 6, start: "14:00", end: "01:00", reason: "Indisponible l'après-midi/soir" },
    { name: "Scarlett Johansson",  day: 7, start: "14:00", end: "01:00", reason: "Indisponible l'après-midi/soir" },
  ];
  const r2RestrRows = r2RestrDefs.map(r => {
    const worker = r2Created.find(u => u.name === r.name)!;
    return { workerId: worker.id, restaurantId: r2.id, dayOfWeek: r.day, startTime: r.start, endTime: r.end, reason: r.reason };
  });
  db.insert(workerRestrictions).values(r2RestrRows).run();
  console.log(`  ✓ Worker restrictions (${r2RestrRows.length} restrictions for ${r2Workers.length} workers)`);

  // ── Worker preferences (R2 only) ──

  const r2Prefs: Record<string, { prefMorning?: number[]; prefEvening?: number[] }> = {
    "Robert De Niro": { prefEvening: [4, 5, 6] },
    "Al Pacino": { prefEvening: [3, 4, 5, 6] },
    "Meryl Streep": { prefMorning: [2, 3, 4, 5] },
    "Jack Nicholson": { prefEvening: [5, 6] },
    "Samuel L. Jackson": { prefMorning: [2, 3, 4], prefEvening: [5, 6] },
    "Scarlett Johansson": { prefMorning: [2, 3, 4, 5, 6, 7] },
    "Denzel Washington": { prefMorning: [2, 3, 4, 5, 6] },
    "Keanu Reeves": { prefEvening: [4, 5, 6] },
    "Anthony Hopkins": { prefMorning: [2, 3, 4], prefEvening: [5, 6] },
    "Cate Blanchett": { prefMorning: [2, 3, 4, 5, 6, 7] },
    "Tom Hanks": { prefMorning: [2, 3, 4, 5, 6, 7] },
    "Brad Pitt": { prefEvening: [4, 5, 6] },
    "Angelina Jolie": { prefEvening: [3, 4, 5, 6] },
    "Leonardo DiCaprio": { prefMorning: [2, 3, 4, 5, 6] },
    "Ryan Gosling": { prefEvening: [3, 4, 5, 6] },
    "Anne Hathaway": { prefMorning: [2, 3, 4, 5, 6, 7] },
    "Joaquin Phoenix": { prefEvening: [3, 4, 5, 6] },
    "Matt Damon": { prefMorning: [2, 3, 4, 5, 6] },
    "Sandra Bullock": { prefMorning: [2, 3, 4, 5, 6, 7] },
    "Dwayne Johnson": { prefMorning: [2, 3, 4, 5, 6], prefEvening: [5, 6] },
  };

  const r2PrefRows: any[] = [];
  for (const w of r2Workers) {
    const rolePool = w.role === "kitchen" ? r2Kitchen : r2Servers;
    const idx = rolePool.findIndex(u => u.id === w.id);
    const defaultPref =
      idx < 7 ? { prefMorning: [2, 3, 4, 5, 6, 7] } :
      idx < 14 ? { prefEvening: [2, 3, 4, 5, 6, 7] } :
      { prefMorning: [2, 3, 4, 5, 6, 7], prefEvening: [2, 3, 4, 5, 6, 7] };
    const pref = r2Prefs[w.name] ?? defaultPref;
    for (let day = 2; day <= 7; day++) {
      const morning = pref.prefMorning?.includes(day) ?? false;
      const evening = pref.prefEvening?.includes(day) ?? false;
      if (morning || evening) {
        r2PrefRows.push({ workerId: w.id, restaurantId: r2.id, dayOfWeek: day, midi: morning, soir: evening, zones: '{}' });
      }
    }
  }
  db.insert(workerPreferredSchedule).values(r2PrefRows).run();
  console.log(`  ✓ Worker preferred schedules (${r2PrefRows.length} entries)`);

  // ── Closures (R2) ──
  const r2ClStart1 = new Date(currentMonday); r2ClStart1.setDate(currentMonday.getDate() + 22);
  const r2ClEnd1 = new Date(r2ClStart1); r2ClEnd1.setDate(r2ClStart1.getDate() + 4);
  const r2Closures = [
    { restaurantId: r2.id, startDate: fmtDate(r2ClStart1), endDate: fmtDate(r2ClEnd1), reason: "Rénovation salle — Morgan Freeman veut un nouveau parquet" },
  ];
  db.insert(restaurantClosures).values(r2Closures).run();
  function isR2Closed(d: string) { return r2Closures.some(c => d >= c.startDate && d <= c.endDate); }

  // ── Services (January 2025+ history; current + next weeks stay empty) ──
  const r2AllServices: Service[] = [];
  const r2Revenue: { restaurantId: string; date: string; amount: number; notes: string | null }[] = [];

  const kitchenNotes2 = [
    "De Niro a fixé le steak pendant 5 minutes avant de le retourner. Cuisson parfaite.",
    "Pacino a crié HOO-AH si fort que les clients ont applaudi depuis la salle.",
    "Streep a improvisé un plat thaï. Standing ovation en cuisine.",
    "Nicholson a souri en flambant les crêpes. Ça a failli mal tourner. C'était spectaculaire.",
    "Jackson a remis en place un commis: 'SAY BEURRE BLANC AGAIN!'",
    null, null, null, null,
  ];
  const serverNotes2 = [
    "Hanks a mémorisé les 14 commandes de la table 8 sans carnet.",
    "Pitt a vendu 6 bouteilles de Pétrus en souriant. Record mensuel.",
    "Jolie a géré la soirée ambassade sans un faux pas.",
    "DiCaprio a convaincu toute la table de passer au menu végé.",
    "Lawrence a trébuché, rattrapé l'assiette, et fait une révérence. Standing ovation.",
    "Gosling n'a pas dit un mot du service. Service parfait.",
    null, null, null, null,
  ];

  function addR2Service(w: Worker, date: string, start: string, end: string, pool: (string | null)[]) {
    const noteIdx = Math.abs(hashCode(w.id + date)) % pool.length;
    r2AllServices.push({ workerId: w.id, restaurantId: r2.id, date, startTime: start, endTime: end, role: w.role as "kitchen" | "floor", notes: pool[noteIdx] });
    // Track weekly hours for fair distribution
    const mins = (toMin(end) < toMin(start) ? toMin(end) + 24 * 60 : toMin(end)) - toMin(start);
    addSeedWeekHours(w.id, currentSeedWeekMonday, mins);
  }

  const r2TargetCount = (dayOfWeek: number, role: "kitchen" | "floor", zone: string) =>
    r2Targets.find(t => t.day === dayOfWeek && t.role === role && t.zone === zone)?.count ?? 0;

  // Service generation uses profile-specific times: morning, evening, and paired coupure workers.
  // Demand intentionally sits slightly above the lean 40-worker contract base so overtime appears.
  for (let week = 0; week < DEMO_SERVICE_WEEKS; week++) {
    const weekMon2 = new Date(startMonday); weekMon2.setDate(startMonday.getDate() + week * 7);
    currentSeedWeekMonday = fmtDate(weekMon2);
    for (let day = 0; day < 7; day++) {
      const d = new Date(startMonday); d.setDate(startMonday.getDate() + week * 7 + day);
      const date = fmtDate(d);
      const rot = week * 19 + day * 11;
      const isPast = date < todayStr;
      if (day === 0) continue; // Monday closed
      if (isR2Closed(date)) continue;
      if (date >= currentMondayStr && date <= demoEmptyUntilStr) continue;
      if (date > serviceCutoffStr) continue;

      const dayK2 = new Map<string, Array<{start: string; end: string}>>();
      const dayS2 = new Map<string, Array<{start: string; end: string}>>();

      if (day >= 1 && day <= 6) {
        const dow = day + 1;
        const isSunday = dow === 7;
        // Coupure kitchen: 09:30-15:00 + 17:00-22:30
        const kCoup1s = jitter("09:30", 10, rot), kCoup1e = jitter("15:00", 10, rot+1);
        const kCoup2s = jitter("17:00", 10, rot+2), kCoup2e = jitter("22:30", 10, rot+3);
        // Coupure floor: 09:30-15:15 + 16:45-22:30
        const sCoup1s = jitter("09:30", 10, rot+4), sCoup1e = jitter("15:15", 10, rot+5);
        const sCoup2s = jitter("16:45", 10, rot+6), sCoup2e = jitter("22:30", 10, rot+7);
        // Midi: 08:00-16:00, with Sunday override times
        const kMids = jitter(isSunday ? "08:15" : "08:00", 10, rot+8), kMide = jitter(isSunday ? "16:15" : "16:00", 10, rot+9);
        const sMids = jitter(isSunday ? "08:30" : "08:00", 10, rot+10), sMide = jitter(isSunday ? "16:30" : "16:00", 10, rot+11);
        // Soir: 16:00-00:00
        const kSois = jitter("16:00", 10, rot+12), kSoie = jitter("00:00", 10, rot+13);
        const sSois = jitter("16:00", 10, rot+14), sSoie = jitter("00:00", 10, rot+15);

        const kCoup = pickCompliant(r2KitchenChefs, r2TargetCount(dow, "kitchen", "Coupure"), rot, dayK2, kCoup1s, kCoup1e); kCoup.forEach(w => {
          trackService(dayK2, w.id, kCoup1s, kCoup1e); addR2Service(w, date, kCoup1s, kCoup1e, kitchenNotes2);
          trackService(dayK2, w.id, kCoup2s, kCoup2e); addR2Service(w, date, kCoup2s, kCoup2e, kitchenNotes2);
        });
        const sCoup = pickCompliant(r2SalleChefDeRang, r2TargetCount(dow, "floor", "Coupure"), rot+1, dayS2, sCoup1s, sCoup1e); sCoup.forEach(w => {
          trackService(dayS2, w.id, sCoup1s, sCoup1e); addR2Service(w, date, sCoup1s, sCoup1e, serverNotes2);
          trackService(dayS2, w.id, sCoup2s, sCoup2e); addR2Service(w, date, sCoup2s, sCoup2e, serverNotes2);
        });
        const kMid = pickCompliant(r2Kitchen, r2TargetCount(dow, "kitchen", "Midi"), rot+5, dayK2, kMids, kMide); kMid.forEach(w => { trackService(dayK2, w.id, kMids, kMide); addR2Service(w, date, kMids, kMide, kitchenNotes2); });
        const sMid = pickCompliant(r2Servers, r2TargetCount(dow, "floor", "Midi"), rot+8, dayS2, sMids, sMide); sMid.forEach(w => { trackService(dayS2, w.id, sMids, sMide); addR2Service(w, date, sMids, sMide, serverNotes2); });
        const kSoi = pickCompliant(r2Kitchen, r2TargetCount(dow, "kitchen", "Soir"), rot+11, dayK2, kSois, kSoie); kSoi.forEach(w => { trackService(dayK2, w.id, kSois, kSoie); addR2Service(w, date, kSois, kSoie, kitchenNotes2); });
        const sSoi = pickCompliant(r2Servers, r2TargetCount(dow, "floor", "Soir"), rot+14, dayS2, sSois, sSoie); sSoi.forEach(w => { trackService(dayS2, w.id, sSois, sSoie); addR2Service(w, date, sSois, sSoie, serverNotes2); });
        if (isPast) r2Revenue.push({ restaurantId: r2.id, date, amount: randInt(day === 5 ? 9000 : day === 4 ? 7000 : day === 6 ? 6500 : 4500, day === 5 ? 14000 : day === 4 ? 10500 : day === 6 ? 9000 : 7000, rot) * 100, notes: null });
      }
    }
  }

  // Dedup overlapping
  const r2Clean = r2AllServices.filter((s, i) => {
    for (let j = 0; j < i; j++) {
      const o = r2AllServices[j];
      if (o.workerId === s.workerId && o.date === s.date && serviceOverlaps(s, o)) return false;
    }
    return true;
  });
  batchInsert(services, r2Clean);
  batchInsert(dailyRevenue, r2Revenue);
  const r2Removed = r2AllServices.length - r2Clean.length;
  const r2PublishedMondays = [...new Set(r2Clean.map(s => mondayOf(s.date)))];
  batchInsert(publishedWeeks, r2PublishedMondays.map(m => ({
    restaurantId: r2.id,
    weekDate: m,
    publishedAt: demoPublishedAtForWeek(m),
  })));
  console.log(`  ✓ ${r2Clean.length} services${r2Removed ? ` (${r2Removed} overlaps removed)` : ""}, ${r2Revenue.length} revenue entries, ${r2PublishedMondays.length} weeks published`);

  // ── Holidays (R2) — mix of approved, pending, some medical ──
  const r2Admin = r2Created[0];
  const hanks = r2Created.find(u => u.name === "Tom Hanks")!;
  const pitt = r2Created.find(u => u.name === "Brad Pitt")!;
  const jolie = r2Created.find(u => u.name === "Angelina Jolie")!;
  const dicaprio = r2Created.find(u => u.name === "Leonardo DiCaprio")!;
  const gosling = r2Created.find(u => u.name === "Ryan Gosling")!;
  const phoenix = r2Created.find(u => u.name === "Joaquin Phoenix")!;
  const reeves = r2Created.find(u => u.name === "Keanu Reeves")!;
  const anthony = r2Created.find(u => u.name === "Anthony Hopkins")!;
  const damon = r2Created.find(u => u.name === "Matt Damon")!;
  const bullock = r2Created.find(u => u.name === "Sandra Bullock")!;
  const hathaway = r2Created.find(u => u.name === "Anne Hathaway")!;
  const dwayne = r2Created.find(u => u.name === "Dwayne Johnson")!;

  const r2NwMon = new Date(currentMonday); r2NwMon.setDate(currentMonday.getDate() + 7);
  const r2NwFri = new Date(r2NwMon); r2NwFri.setDate(r2NwMon.getDate() + 4);
  const r2In2w = new Date(currentMonday); r2In2w.setDate(currentMonday.getDate() + 14);
  const r2In2wThu = new Date(r2In2w); r2In2wThu.setDate(r2In2w.getDate() + 3);
  const r2In3w = new Date(currentMonday); r2In3w.setDate(currentMonday.getDate() + 21);
  const r2In3wWed = new Date(r2In3w); r2In3wWed.setDate(r2In3w.getDate() + 2);
  const r2LastW = new Date(currentMonday); r2LastW.setDate(currentMonday.getDate() - 4);
  const r2LastWFri = new Date(r2LastW); r2LastWFri.setDate(r2LastW.getDate() + 2);
  const r2TwoWeeksAgo = new Date(currentMonday); r2TwoWeeksAgo.setDate(currentMonday.getDate() - 10);
  const r2TwoWeeksAgoEnd = new Date(r2TwoWeeksAgo); r2TwoWeeksAgoEnd.setDate(r2TwoWeeksAgo.getDate() + 2);

  const deniro = r2Created.find(u => u.name === "Robert De Niro")!;
  const pacino = r2Created.find(u => u.name === "Al Pacino")!;
  const streep = r2Created.find(u => u.name === "Meryl Streep")!;
  const johansson = r2Created.find(u => u.name === "Scarlett Johansson")!;

  const r2HolidayRows: HolidaySeedRow[] = [
    // ── Next week: realistic review queue — 1 kitchen + 1 server overlap ──
    { workerId: pacino.id, restaurantId: r2.id, startDate: fmtDate(r2NwMon), endDate: fmtDate(r2NwFri),
      reason: "Opération du genou — le médecin dit 5 jours minimum. HOO-AH.", status: "pending", medical: true },
    { workerId: jolie.id, restaurantId: r2.id, startDate: fmtDate(r2NwMon), endDate: fmtDate(r2NwFri),
      reason: "Mission humanitaire au Cambodge. Je serai joignable par satellite.", status: "pending" },
    // ── Later pending requests (normal approval flow) ──
    { workerId: pitt.id, restaurantId: r2.id, startDate: fmtDate(r2In2w), endDate: fmtDate(r2In2wThu),
      reason: "Festival de Cannes. Promotion du nouveau film. Je ramène du rosé.", status: "pending" },
    { workerId: reeves.id, restaurantId: r2.id, startDate: fmtDate(r2In3w), endDate: fmtDate(r2In3wWed),
      reason: "Retraite silencieuse au Japon. Pas de téléphone, pas de mail, juste le zen.", status: "pending" },
    // ── Recent approved holidays ──
    { workerId: dwayne.id, restaurantId: r2.id, startDate: fmtDate(r2TwoWeeksAgo), endDate: fmtDate(r2TwoWeeksAgoEnd),
      reason: "Repos après plusieurs week-ends de renfort.", status: "approved", reviewedBy: r2Admin.id, reviewedAt: fmtDate(r2TwoWeeksAgo) },
    { workerId: bullock.id, restaurantId: r2.id, startDate: fmtDate(r2LastW), endDate: fmtDate(r2LastW),
      reason: "Grippe saisonnière.", status: "approved", medical: true, reviewedBy: r2Admin.id, reviewedAt: fmtDate(r2LastW) },
  ];
  const leaveWindows = [
    "2025-06-09", "2025-06-23", "2025-07-07", "2025-07-21",
    "2025-08-04", "2025-08-18", "2025-09-08", "2025-09-22",
    "2025-10-06", "2025-10-20", "2025-11-03", "2025-11-17",
    "2025-12-01", "2025-12-15", "2026-01-05", "2026-01-19",
    "2026-02-02", "2026-02-16", "2026-03-02", "2026-03-16",
    "2026-03-30", "2026-04-13",
  ];
  const sortedOps = [...r2Workers].sort((a, b) => a.name.localeCompare(b.name));
  for (let idx = 0; idx < sortedOps.length; idx++) {
    const worker = sortedOps[idx];
    const simulatedTarget = demoTargetTakenDays(worker as DemoOwnerWorker);
    const targetTaken = worker.name === "Michelle Yeoh" || worker.name === "Idris Elba"
      ? simulatedTarget
      : Math.max(0, simulatedTarget - 1);
    let remainingToSeed = targetTaken;
    let block = 0;
    while (remainingToSeed > 0) {
      const days = Math.min(5, remainingToSeed);
      const windowIdx = (Math.abs(hashCode(`${worker.name}_${block}`)) + idx * 3 + block * 5) % leaveWindows.length;
      const start = days >= 5
        ? leaveWindows[windowIdx]
        : addDays(leaveWindows[windowIdx], Math.abs(hashCode(`${worker.name}_${block}`)) % Math.max(1, 6 - days));
      const end = addDays(start, days - 1);
      r2HolidayRows.push({
        workerId: worker.id,
        restaurantId: r2.id,
        startDate: start,
        endDate: end,
        reason: "Planification CP assistée — couverture solveur OK.",
        status: "approved",
        source: "admin_proposal",
        reviewedBy: r2Admin.id,
        reviewedAt: start,
      });
      remainingToSeed -= days;
      block++;
    }
  }
  db.insert(holidayRequests).values(r2HolidayRows).run();
  console.log(`  ✓ ${r2HolidayRows.length} holiday requests (${r2HolidayRows.filter(h => h.status === "approved").length} approved past, 4 pending) — next week: 2 pending simultaneously`);

  if (process.env.DEMO_OWNER_SOLVER_SEED === "1") {
    // Expensive generator/audit mode: replay owner decisions week by week and
    // accept each CP block only when CP-SAT proves coverage still works.
    await rebuildGrandBrasserieOwnerHistory(r2.id);
  } else {
    console.log("  ✓ Owner week-by-week CP history loaded from precomputed seed (set DEMO_OWNER_SOLVER_SEED=1 to regenerate with CP-SAT)");
  }

  // ── Replacements (R2) — owner-mediated replacement flow (not two-way swaps) ──
  const r2FutureServices = db.select().from(services)
    .where(and(gte(services.date, todayStr), eq(services.restaurantId, r2.id))).all();

  const r2ReplacementData = [
    { reqId: pitt.id, tgtId: gosling.id, msg: "Je ne peux pas assurer ce service, pouvez-vous me trouver un remplaçant ?", status: "awaiting_admin_decision" as const },
    { reqId: jolie.id, tgtId: dicaprio.id, msg: "Imprévu personnel ce jour-là, je dois être remplacée.", status: "awaiting_admin_decision" as const },
    { reqId: dwayne.id, tgtId: bullock.id, msg: "Rendez-vous important, besoin d'un remplacement pour ce service.", status: "awaiting_worker_reply" as const },
    { reqId: damon.id, tgtId: hanks.id, msg: "Contrainte familiale, merci d'avoir trouvé un remplaçant.", status: "accepted" as const },
    { reqId: bullock.id, tgtId: hathaway.id, msg: "Rendez-vous scolaire impossible à déplacer.", status: "accepted" as const },
    { reqId: dicaprio.id, tgtId: pitt.id, msg: "Déplacement associatif prévu ce jour-là.", status: "rejected" as const },
  ];

  let r2ReplacementCount = 0;
  for (const sw of r2ReplacementData) {
    const service = r2FutureServices.find(s => s.workerId === sw.reqId);
    if (!service) continue;
    const workerNotifiedAt = sw.status === "awaiting_admin_decision" ? null : new Date();
    const expiresAt = replacementReplyExpiresAt(workerNotifiedAt ?? new Date());
    const isResolved = sw.status === "accepted" || sw.status === "rejected";
    db.insert(replacementRequests).values({
      requesterId: sw.reqId,
      requesterServiceId: service.id,
      targetId: sw.status === "awaiting_admin_decision" ? null : sw.tgtId,
      restaurantId: r2.id,
      status: sw.status,
      message: sw.msg,
      expiresAt,
      respondedAt: isResolved ? new Date().toISOString() : null,
      adminNotifiedAt: new Date().toISOString(),
      workerNotifiedAt: workerNotifiedAt?.toISOString() ?? null,
      candidateIds: [sw.tgtId],
    }).run();
    r2ReplacementCount++;
  }
  console.log(`  ✓ ${r2ReplacementCount} replacement requests (2 awaiting admin, 1 awaiting worker, 2 accepted, 1 rejected)`);

  // ── Time clocks (R2) ──
  // No synthetic lateness history in the sales demo. Keep the Heures story
  // focused on scheduled vs projected hours and overtime, not incident cleanup.
  console.log("  ✓ Grand Brasserie time clocks skipped (no lateness seed)");

  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // RESTAURANT 3 — FRESH: empty slate to test the onboarding funnel
  // ════════════════════════════════════════════════════════════════════════════

  console.log("");
  const r3Owner = createDemoOwner("Mon restaurant");
  const [r3] = db.insert(restaurants).values({
    ownerId: r3Owner.id,
    name: "Mon restaurant",
    address: null,
    timezone: "Europe/Paris",
    status: "demo",
    onboardingCompletedAt: null,
    colorScheme: "classic",
    workerPreferencesEnabled: true,
    tapInOutEnabled: false,
    defaultContractType: DEFAULT_CONTRACT_TYPE,
    defaultContractHours: DEFAULT_CONTRACT_HOURS,
    medicalMode: false,
    reminderFrequency: "off",
    autoStaffingWeeks: 3,
    preferredStyle: "equipe-stable",
    overtimeMode: "flexible",
    kitchenSubRoles: "[]",
    floorSubRoles: "[]",
    subroleHcrMap: "{}",
    disabledComplianceRules: JSON.stringify(["HCR-L3121-16"]),
  }).returning().all();

  const [r3Admin] = await db.insert(users).values({
    name: "Gérant Démo",
    email: "nouveau@nouveau-restaurant.fr",
    phone: "+33600000004",
    passwordHash: pw,
    role: "admin",
    restaurantId: r3.id,
    priority: 1,
  }).returning().all();
  seedMembershipsAndProfiles(r3Owner.id, r3.id, [r3Admin.id]);
  console.log(`  ✓ Restaurant 3: ${r3.name} (Fresh) — empty, onboarding pending`);


  // ══════════════════════════════════════════════════════════════════════════
  // CALENDAR EVENTS (jours fériés + vacances scolaires)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n  📅 Fetching calendar events from gov APIs...");
  const [cal1, cal1b, cal2] = await Promise.all([
    refreshCalendarEvents(r1.id),
    refreshCalendarEvents(r1b.id),
    refreshCalendarEvents(r2.id),
  ]);
  console.log(`  ✓ Chez Reno: ${cal1.holidays} jours fériés, ${cal1.vacations} vacances${cal1.errors.length ? " (" + cal1.errors.join(", ") + ")" : ""}`);
  console.log(`  ✓ La Civette: ${cal1b.holidays} jours fériés, ${cal1b.vacations} vacances${cal1b.errors.length ? " (" + cal1b.errors.join(", ") + ")" : ""}`);
  console.log(`  ✓ Grand Brasserie: ${cal2.holidays} jours fériés, ${cal2.vacations} vacances${cal2.errors.length ? " (" + cal2.errors.join(", ") + ")" : ""}`);

  console.log("\n  ☀️  Fetching weather from Open-Meteo...");
  const [w1, w1b, w2] = await Promise.all([
    refreshWeather(r1.id),
    refreshWeather(r1b.id),
    refreshWeather(r2.id),
  ]);
  console.log(`  ✓ Chez Reno: ${w1.updated} jours de météo${w1.errors.length ? " (" + w1.errors.join(", ") + ")" : ""}`);
  console.log(`  ✓ La Civette: ${w1b.updated} jours de météo${w1b.errors.length ? " (" + w1b.errors.join(", ") + ")" : ""}`);
  console.log(`  ✓ Grand Brasserie: ${w2.updated} jours de météo${w2.errors.length ? " (" + w2.errors.join(", ") + ")" : ""}`);

  // ══════════════════════════════════════════════════════════════════════════
  // DONE
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n✅ Seed complete!\n");
  console.log("  🍷 Chez Reno + La Civette (Multi-restaurant)");
  console.log("     Palette: sunset | MIDI/SOIR uniquement | 1 objectif staffing");
  console.log("     Même owner: Jean Reno peut basculer entre les deux restaurants");
  console.log("     8 employés opérationnels chez Reno + 3 autorisations de partage vers La Civette");
  console.log("     Récap heures/Silae: les services La Civette remontent en analytique côté Chez Reno\n");
  console.log("  🌊 The Grand Brasserie (Complex)");
  console.log("     Palette: ocean (teal/amber) | 3 zones (Coupure/Midi/Soir) | 1 objectif staffing");
  console.log("     42 employés opérationnels: Morgan Freeman (gérant) + 21 cuisine + 21 service");
  console.log("     Remplacements multiples | Medical mode: ON | Préférences: ON\n");
  console.log("  ✨ Mon restaurant (Fresh)");
  console.log("     Aucun employé, aucun service — pour tester le funnel d'onboarding\n");
  console.log("  Login: any email / password: comptoir123");
  console.log("  Demo: no password required on /demo page\n");

  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
