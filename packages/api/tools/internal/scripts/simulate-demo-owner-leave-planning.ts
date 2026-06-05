import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db, rawDb } from "../../../src/db/connection.js";
import {
  dailyRevenue,
  holidayRequests,
  openShifts,
  publishedWeeks,
  replacementRequests,
  restaurants,
  services,
  staffingSchedule,
  timeClocks,
  users,
} from "../../../src/db/schema.js";
import { generatePlan } from "../../../src/routes/autostaffing.js";
import { computeLeaveIntelligence } from "../../../src/services/leave-intelligence.js";
import { isoWeekNum, weekDates } from "../../../src/utils/scheduling.js";

type Worker = {
  id: string;
  name: string;
  role: "kitchen" | "floor";
};

type PlannedLeave = {
  workerId: string;
  startDate: string;
  endDate: string;
};

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function fmtDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T12:00:00`);
  date.setDate(date.getDate() + days);
  return fmtDate(date);
}

function mondayOf(dateStr: string): string {
  const date = new Date(`${dateStr}T12:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return fmtDate(date);
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function leaveDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function overlaps(a: PlannedLeave, b: PlannedLeave): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

function targetTakenDays(worker: Worker): number {
  const named: Record<string, number> = {
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
  return named[worker.name] ?? (25 + (hashCode(worker.name) % 3));
}

function candidateDuration(worker: Worker, weekIndex: number, remaining: number): number {
  const cycle = [5, 5, 5, 4, 5, 5];
  const wanted = cycle[(hashCode(worker.name) + weekIndex) % cycle.length];
  return Math.max(1, Math.min(remaining, wanted));
}

function candidateStart(monday: string, worker: Worker, duration: number, weekIndex: number): string {
  if (duration >= 5) return monday;
  const offset = (hashCode(`${worker.name}_${weekIndex}`) % Math.max(1, 6 - duration));
  return addDays(monday, offset);
}

function countCoveredSlots(plan: Awaited<ReturnType<typeof generatePlan>>): number {
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

const today = new Date();
const todayStr = fmtDate(today);
const currentMonday = mondayOf(todayStr);
const historyStart = "2025-01-06";
const planningStart = "2025-06-02";
const lastHistoricalMonday = addDays(currentMonday, -7);

const [restaurant] = db.select({ id: restaurants.id, name: restaurants.name })
  .from(restaurants)
  .where(eq(restaurants.name, "The Grand Brasserie"))
  .limit(1)
  .all();

if (!restaurant) fail("The Grand Brasserie demo restaurant was not found. Run the seed first.");

const [admin] = db.select({ id: users.id })
  .from(users)
  .where(and(eq(users.restaurantId, restaurant.id), eq(users.role, "admin")))
  .limit(1)
  .all();

if (!admin) fail("The Grand Brasserie admin was not found.");

const workers = db.select({ id: users.id, name: users.name, role: users.role })
  .from(users)
  .where(and(eq(users.restaurantId, restaurant.id), inArray(users.role, ["kitchen", "floor"]), eq(users.active, true)))
  .orderBy(users.role, users.name)
  .all() as Worker[];

if (workers.length !== 42) fail(`Expected 42 operational workers, got ${workers.length}.`);

console.log(`↻ Rebuilding ${restaurant.name} history with CP-SAT-backed weekly owner decisions`);

rawDb.exec("PRAGMA foreign_keys = OFF");
db.delete(replacementRequests).where(eq(replacementRequests.restaurantId, restaurant.id)).run();
db.delete(openShifts).where(eq(openShifts.restaurantId, restaurant.id)).run();
db.delete(timeClocks).where(eq(timeClocks.restaurantId, restaurant.id)).run();
db.delete(dailyRevenue).where(eq(dailyRevenue.restaurantId, restaurant.id)).run();
db.delete(publishedWeeks).where(eq(publishedWeeks.restaurantId, restaurant.id)).run();
db.delete(services).where(eq(services.restaurantId, restaurant.id)).run();
db.delete(holidayRequests).where(eq(holidayRequests.restaurantId, restaurant.id)).run();
rawDb.exec("PRAGMA foreign_keys = ON");

const taken = new Map(workers.map((worker) => [worker.id, 0]));
const acceptedLeaves: PlannedLeave[] = [];
let accepted = 0;
let rejected = 0;
let staffedWeeks = 0;
let insertedServices = 0;
let intelligenceChecks = 0;
let historicalUnderfilledWeeks = 0;

function candidateOrder(weekIndex: number): Worker[] {
  return [...workers].sort((a, b) => {
    const aGap = targetTakenDays(a) - (taken.get(a.id) ?? 0);
    const bGap = targetTakenDays(b) - (taken.get(b.id) ?? 0);
    if (bGap !== aGap) return bGap - aGap;
    return ((hashCode(`${a.name}_${weekIndex}`) % 97) - (hashCode(`${b.name}_${weekIndex}`) % 97));
  });
}

async function tryLeave(worker: Worker, monday: string, weekIndex: number, weekLeaves: PlannedLeave[]): Promise<boolean> {
  const remaining = targetTakenDays(worker) - (taken.get(worker.id) ?? 0);
  if (remaining <= 0) return false;
  const duration = candidateDuration(worker, weekIndex, remaining);
  const startDate = candidateStart(monday, worker, duration, weekIndex);
  const endDate = addDays(startDate, duration - 1);
  const candidate = { workerId: worker.id, startDate, endDate };

  if (acceptedLeaves.some((leave) => leave.workerId === worker.id && overlaps(leave, candidate))) return false;
  if (weekLeaves.some((leave) => leave.workerId === worker.id)) return false;

  const baseline = await generatePlan(restaurant.id, monday, undefined, {
    holidayFilter: ["approved"],
    extraAbsences: weekLeaves,
    maxTier: 2,
  });
  if (baseline.solverUsed === "ilp-fallback") fail(`CP-SAT unavailable while building baseline for week ${monday}.`);
  const baselineUncovered = countCoveredSlots(baseline);
  const baselineCompliance = baseline.complianceWarnings?.length ?? 0;

  const plan = await generatePlan(restaurant.id, monday, undefined, {
    holidayFilter: ["approved"],
    extraAbsences: [...weekLeaves, candidate],
    maxTier: 2,
  });
  if (plan.solverUsed === "ilp-fallback") fail(`CP-SAT unavailable while testing ${worker.name} for week ${monday}.`);
  if (plan.solverStatus !== "optimal" && plan.solverStatus !== "feasible") {
    rejected++;
    return false;
  }
  if (countCoveredSlots(plan) > baselineUncovered || (plan.complianceWarnings?.length ?? 0) > baselineCompliance) {
    rejected++;
    return false;
  }

  db.insert(holidayRequests).values({
    workerId: worker.id,
    restaurantId: restaurant.id,
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
  taken.set(worker.id, (taken.get(worker.id) ?? 0) + leaveDays(startDate, endDate));
  accepted++;
  console.log(`  ✓ ${monday}: ${worker.name} (${worker.role}) ${startDate}→${endDate}`);
  return true;
}

async function staffWeek(monday: string): Promise<void> {
  const plan = await generatePlan(restaurant.id, monday, undefined, { holidayFilter: ["approved"], maxTier: 2 });
  if (plan.solverUsed === "ilp-fallback") fail(`CP-SAT unavailable while staffing week ${monday}.`);
  if (plan.solverStatus !== "optimal" && plan.solverStatus !== "feasible") fail(`No feasible staffing plan for ${monday}.`);
  const uncovered = countCoveredSlots(plan);
  if (uncovered > 0) historicalUnderfilledWeeks++;

  if (plan.services.length > 0) {
    db.insert(services).values(plan.services.map((service) => ({
      workerId: service.workerId,
      restaurantId: restaurant.id,
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
  db.insert(publishedWeeks).values({ restaurantId: restaurant.id, weekDate: monday }).run();

  const dates = weekDates(monday);
  const revenueRows = dates
    .filter((date) => date < todayStr && date < currentMonday)
    .map((date) => {
      const dow = new Date(`${date}T12:00:00`).getDay();
      const dayBoost = dow === 5 ? 9800 : dow === 6 ? 8400 : dow === 0 ? 7600 : 5600;
      const variance = hashCode(`${restaurant.id}_${date}`) % 2400;
      return { restaurantId: restaurant.id, date, amount: (dayBoost + variance) * 100, notes: null };
    });
  if (revenueRows.length > 0) db.insert(dailyRevenue).values(revenueRows).run();

  staffedWeeks++;
  insertedServices += plan.services.length;
}

let weekIndex = 0;
for (let monday = historyStart; monday <= lastHistoricalMonday; monday = addDays(monday, 7), weekIndex++) {
  const weekLeaves: PlannedLeave[] = [];
  if (monday >= planningStart) {
    const maxLeaves = weekIndex % 6 === 0 ? 3 : weekIndex % 3 === 0 ? 5 : 4;
    const roleCount = new Map<Worker["role"], number>([["kitchen", 0], ["floor", 0]]);
    for (const worker of candidateOrder(weekIndex)) {
      if (weekLeaves.length >= maxLeaves) break;
      if ((roleCount.get(worker.role) ?? 0) >= 3) continue;
      const ok = await tryLeave(worker, monday, weekIndex, weekLeaves);
      if (ok) roleCount.set(worker.role, (roleCount.get(worker.role) ?? 0) + 1);
    }
    if (accepted > 0 && accepted % 8 === 0) {
      const intelligence = await computeLeaveIntelligence(restaurant.id);
      intelligenceChecks++;
      const solverSuggestions = intelligence.advice.workerSuggestions.filter((suggestion) => suggestion.source === "solver").length;
      const totalRemaining = Math.round(intelligence.balances.reduce((sum, balance) => sum + balance.remainingDays, 0) * 10) / 10;
      console.log(`    intelligence congés: ${solverSuggestions} propositions solveur, ${totalRemaining}j restants`);
    }
  }
  await staffWeek(monday);
}

const nextWeek = addDays(currentMonday, 7);
const inTwoWeeks = addDays(currentMonday, 14);
const inThreeWeeks = addDays(currentMonday, 21);
const pendingRows = [
  { name: "Al Pacino", startDate: nextWeek, endDate: addDays(nextWeek, 4), reason: "Opération du genou — le médecin dit 5 jours minimum. HOO-AH.", medical: true },
  { name: "Angelina Jolie", startDate: nextWeek, endDate: addDays(nextWeek, 4), reason: "Mission humanitaire au Cambodge. Je serai joignable par satellite.", medical: false },
  { name: "Brad Pitt", startDate: inTwoWeeks, endDate: addDays(inTwoWeeks, 3), reason: "Festival de Cannes. Promotion du nouveau film. Je ramène du rosé.", medical: false },
  { name: "Keanu Reeves", startDate: inThreeWeeks, endDate: addDays(inThreeWeeks, 2), reason: "Retraite silencieuse au Japon. Pas de téléphone, pas de mail, juste le zen.", medical: false },
];
for (const pending of pendingRows) {
  const worker = workers.find((w) => w.name === pending.name);
  if (!worker) continue;
  db.insert(holidayRequests).values({
    workerId: worker.id,
    restaurantId: restaurant.id,
    startDate: pending.startDate,
    endDate: pending.endDate,
    reason: pending.reason,
    status: "pending",
    source: "worker",
    medical: pending.medical,
  }).run();
}

// Keep one recent medical absence visible in the holiday inbox without counting it as PTO.
const bullock = workers.find((w) => w.name === "Sandra Bullock");
if (bullock) {
  const sickDate = addDays(currentMonday, -4);
  db.insert(holidayRequests).values({
    workerId: bullock.id,
    restaurantId: restaurant.id,
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

const intelligence = await computeLeaveIntelligence(restaurant.id);
const balances = intelligence.balances.filter((balance) => balance.role === "kitchen" || balance.role === "floor");
const totalRemaining = Math.round(balances.reduce((sum, balance) => sum + balance.remainingDays, 0) * 10) / 10;
const critical = balances.filter((balance) => balance.expiringSoon).length;
const solverSuggestions = intelligence.advice.workerSuggestions.filter((suggestion) => suggestion.source === "solver").length;

const scheduleWeeks = db.select({ year: staffingSchedule.year, week: staffingSchedule.week })
  .from(staffingSchedule)
  .where(and(
    eq(staffingSchedule.restaurantId, restaurant.id),
    gte(staffingSchedule.year, 2025),
    lte(staffingSchedule.year, today.getFullYear()),
  ))
  .all();

console.log(`✓ Staffed ${staffedWeeks} historical weeks (${insertedServices} auto services)`);
console.log(`✓ Approved ${accepted} PTO blocks one by one, rejected ${rejected} because solver/compliance said no`);
console.log(`✓ Baseline demand was too high on ${historicalUnderfilledWeeks} historical week(s); no accepted PTO made those weeks worse`);
console.log(`✓ Checked leave intelligence ${intelligenceChecks + 1} times during the simulation`);
console.log(`✓ Current leave intelligence: ${critical} critical balances, ${totalRemaining}j remaining, ${solverSuggestions} solver-backed proposals`);
console.log(`✓ Staffing schedule rows available: ${scheduleWeeks.length}`);

if (solverSuggestions === 0) fail("Expected solver-backed leave proposals after simulation, got none.");
if (totalRemaining > 520) fail(`Too much PTO remains (${totalRemaining}j); owner simulation did not spread enough leave.`);
if (totalRemaining < 120) fail(`Too little PTO remains (${totalRemaining}j); demo no longer needs leave intelligence.`);
