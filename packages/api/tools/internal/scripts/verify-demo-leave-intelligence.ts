import { db } from "../../../src/db/connection.js";
import { holidayRequests, restaurants, staffingSchedule, staffingTargets, users } from "../../../src/db/schema.js";
import { and, eq, gte, lte } from "drizzle-orm";
import { computeLeaveIntelligence } from "../../../src/services/leave-intelligence.js";
import { generatePlan } from "../../../src/routes/autostaffing.js";
import { isoDayOfWeek, isoWeekNum, weekDates } from "../../../src/utils/scheduling.js";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const [restaurant] = db.select({ id: restaurants.id, name: restaurants.name })
  .from(restaurants)
  .where(eq(restaurants.name, "The Grand Brasserie"))
  .limit(1)
  .all();

if (!restaurant) fail("The Grand Brasserie demo restaurant was not found. Run `bun run db:seed` first.");

const workerCount = db.select({ id: users.id })
  .from(users)
  .where(and(eq(users.restaurantId, restaurant.id), eq(users.active, true)))
  .all()
  .filter((u) => u.id)
  .length;

const staffingWeeks = db.select({
  year: staffingSchedule.year,
  week: staffingSchedule.week,
}).from(staffingSchedule)
  .where(eq(staffingSchedule.restaurantId, restaurant.id))
  .all();

if (staffingWeeks.length < 60) fail(`Expected January 2025+ staffing history, got only ${staffingWeeks.length} weeks.`);

const intelligence = await computeLeaveIntelligence(restaurant.id);
const operationalBalances = intelligence.balances.filter((b) => b.role === "kitchen" || b.role === "floor");
if (operationalBalances.length !== 42) fail(`Expected 42 operational leave balances, got ${operationalBalances.length}.`);

const historicalBalances = operationalBalances.filter((b) => b.earnedDays >= 25);
const totalRemaining = Math.round(operationalBalances.reduce((sum, b) => sum + b.remainingDays, 0) * 10) / 10;
const solverSuggestions = intelligence.advice.workerSuggestions.filter((s) => s.source === "solver");
if (historicalBalances.length < 40) fail(`Expected at least 40 January 2025-tenured workers, got ${historicalBalances.length}.`);
if (intelligence.compliance.length === 0 && totalRemaining > 220) {
  fail(`Expected either CP compliance warnings or a well-spread residual balance; total remaining was ${totalRemaining}j.`);
}
if (solverSuggestions.length === 0) fail("Expected solver-backed leave suggestions, got none.");
if (intelligence.pendingClusters.some((cluster) => cluster.holidays.some((h) => h.reason === "Analyse solveur indisponible"))) {
  fail("Pending holiday analysis fell back to an unavailable solver.");
}

const approvedLeaveWeeks = db.select({
  startDate: holidayRequests.startDate,
  endDate: holidayRequests.endDate,
}).from(holidayRequests)
  .where(and(
    eq(holidayRequests.restaurantId, restaurant.id),
    eq(holidayRequests.status, "approved"),
    gte(holidayRequests.endDate, "2025-01-01"),
  ))
  .all()
  .flatMap((h) => {
    const weeks: string[] = [];
    const cur = new Date(`${mondayOf(h.startDate)}T12:00:00`);
    const end = new Date(`${h.endDate}T12:00:00`);
    while (cur <= end) {
      weeks.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
      cur.setDate(cur.getDate() + 7);
    }
    return weeks;
  });

const sortedWeeks = [...new Set([
  ...staffingWeeks
    .map((w) => {
      const jan4 = new Date(`${w.year}-01-04T12:00:00`);
      const dow = jan4.getDay();
      const week1Monday = new Date(jan4);
      week1Monday.setDate(jan4.getDate() - ((dow + 6) % 7));
      const monday = new Date(week1Monday);
      monday.setDate(week1Monday.getDate() + (w.week - 1) * 7);
      return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    }),
  ...approvedLeaveWeeks,
])].sort();

let checkedWeeks = 0;
let underfilledWeeks = 0;
let underfilledTargets = 0;
for (const monday of sortedWeeks) {
  const dates = weekDates(monday);
  if (dates[0] < "2025-01-01") continue;
  if (dates[0] > new Date().toISOString().slice(0, 10) && checkedWeeks > 0) continue;
  const plan = await generatePlan(restaurant.id, monday, undefined, { holidayFilter: ["approved"], maxTier: 2 });
  if (plan.solverUsed === "ilp-fallback") fail(`CP-SAT was unavailable for week ${monday}; verifier refuses ILP fallback.`);

  const weekNum = isoWeekNum(monday);
  const year = new Date(`${monday}T12:00:00`).getFullYear();
  const [assignment] = db.select({ profileId: staffingSchedule.profileId })
    .from(staffingSchedule)
    .where(and(
      eq(staffingSchedule.restaurantId, restaurant.id),
      eq(staffingSchedule.year, year),
      eq(staffingSchedule.week, weekNum),
    ))
    .limit(1)
    .all();
  if (!assignment) continue;

  const targets = db.select()
    .from(staffingTargets)
    .where(and(eq(staffingTargets.restaurantId, restaurant.id), eq(staffingTargets.profileId, assignment.profileId)))
    .all();
  const fills = new Map<string, Set<string>>();
  for (const service of plan.services) {
    const key = `${isoDayOfWeek(service.date)}_${service.role}_${service.zone}`;
    if (!fills.has(key)) fills.set(key, new Set());
    fills.get(key)!.add(service.workerId);
  }
  const uncovered = targets.filter((target) => {
    if (target.count === 0) return false;
    const key = `${target.dayOfWeek}_${target.role}_${target.zone}`;
    const existing = plan.slotFillSummary.find((s) => s.dow === target.dayOfWeek && s.role === target.role && s.zone === target.zone)?.existingFill ?? 0;
    return existing + (fills.get(key)?.size ?? 0) < target.count;
  });
  if (uncovered.length > 3) fail(`Auto solver left ${uncovered.length} target(s) uncovered for week ${monday}.`);
  if (uncovered.length > 0) {
    underfilledWeeks++;
    underfilledTargets += uncovered.length;
  }
  checkedWeeks++;
}

if (underfilledWeeks > 5) fail(`Too many underfilled weeks for a mostly staffed demo: ${underfilledWeeks}.`);

console.log(`✓ ${restaurant.name}: ${workerCount} active users, ${staffingWeeks.length} staffing weeks`);
console.log(`✓ CP balances: ${historicalBalances.length} historical workers, total remaining ${totalRemaining}j, compliance warnings ${intelligence.compliance.length}`);
console.log(`✓ Leave advice: ${solverSuggestions.length} solver-backed suggestions, ${intelligence.pendingClusters.flatMap((c) => c.holidays).length} pending requests analyzed`);
console.log(`✓ Auto solver verified ${checkedWeeks} weeks with approved holidays/targets (${underfilledWeeks} week(s), ${underfilledTargets} target(s) intentionally underfilled)`);
