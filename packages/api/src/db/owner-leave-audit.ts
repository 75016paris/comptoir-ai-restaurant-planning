import { and, eq, inArray } from "drizzle-orm";
import { db, rawDb } from "./connection.js";
import { holidayRequests, openShifts, replacementRequests, restaurants, services, timeClocks, users } from "./schema.js";
import { generatePlan } from "../routes/autostaffing.js";

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmtDate(d);
}

function workingDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  let count = 0;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0) count++;
  }
  return count;
}

function monthsBetween(startDate: string, asOf: string): number {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${asOf}T12:00:00`);
  if (start >= end) return 0;
  return Math.max(0, Math.min(24, Math.floor((end.getTime() - start.getTime()) / (30.44 * 86400000) + 0.2)));
}

function earnedDays(worker: { startDate: string | null }, asOf: string): number {
  return Math.round(monthsBetween(worker.startDate ?? "2025-01-01", asOf) * 2.5 * 10) / 10;
}

function demoTargetTakenDays(): number {
  return Number(process.env.AUDIT_TARGET_TAKEN_DAYS ?? 20);
}

function unfilled(plan: Awaited<ReturnType<typeof generatePlan>>): number {
  return plan.unfilledSlots?.length ?? 0;
}

function targetSlots(plan: Awaited<ReturnType<typeof generatePlan>>): number {
  return plan.slotFillSummary?.reduce((sum, slot) => sum + (slot.target ?? 0), 0) ?? 0;
}

function assertCpsat(plan: Awaited<ReturnType<typeof generatePlan>>, label: string): void {
  if (plan.solverUsed !== "cpsat") {
    throw new Error(`${label}: expected cpsat, got ${plan.solverUsed ?? "unknown"}`);
  }
}

function planOk(plan: Awaited<ReturnType<typeof generatePlan>>): boolean {
  return (plan.solverStatus === "optimal" || plan.solverStatus === "feasible") && plan.solverUsed === "cpsat";
}

function serviceRows(restaurantId: string, plan: Awaited<ReturnType<typeof generatePlan>>) {
  return plan.services.map((svc) => ({
    restaurantId,
    workerId: svc.workerId,
    date: svc.date,
    startTime: svc.startTime,
    endTime: svc.endTime,
    role: svc.role,
    notes: null,
    source: "auto" as const,
    filledAs: svc.filledAs ?? null,
  }));
}

async function main() {
  const restaurantName = process.env.AUDIT_RESTAURANT ?? "Chez Reno";
  const start = process.env.AUDIT_START ?? "2025-01-06";
  const asOf = process.env.AUDIT_AS_OF ?? "2026-05-19";
  const end = mondayOf(asOf);

  const [restaurant] = db.select({ id: restaurants.id })
    .from(restaurants)
    .where(eq(restaurants.name, restaurantName))
    .limit(1)
    .all();
  if (!restaurant) throw new Error(`${restaurantName} not found`);

  rawDb.exec("PRAGMA foreign_keys=OFF");
  rawDb.query("delete from time_clocks where restaurant_id = ?").run(restaurant.id);
  rawDb.query("delete from open_shifts where restaurant_id = ?").run(restaurant.id);
  db.delete(replacementRequests).where(eq(replacementRequests.restaurantId, restaurant.id)).run();
  db.delete(services).where(eq(services.restaurantId, restaurant.id)).run();
  db.delete(holidayRequests).where(eq(holidayRequests.restaurantId, restaurant.id)).run();
  rawDb.exec("PRAGMA foreign_keys=ON");

  const workers = db.select({
    id: users.id,
    name: users.name,
    role: users.role,
    startDate: users.startDate,
    contractHours: users.contractHours,
  })
    .from(users)
    .where(and(eq(users.restaurantId, restaurant.id), eq(users.active, true), inArray(users.role, ["kitchen", "floor"])))
    .all();

  const approved: Array<{ workerId: string; workerName: string; role: string; startDate: string; endDate: string; remainingBefore: number }> = [];
  const lastLeaveWeek = new Map<string, number>();
  const monthly = new Map<string, number>();
  const decisions: Array<{ week: string; worker: string; role: string; remainingBefore: number; baselineUnfilled: number; finalUnfilled: number }> = [];
  const weekSummaries: Array<{ week: string; solver: string | undefined; status: string | undefined; tier: number | undefined; services: number; baselineUnfilled: number; finalUnfilled: number; targetSlots: number; approved: string | null }> = [];
  let solves = 0;
  let candidateSolves = 0;
  let rejectedCoverage = 0;
  let rejectedRecent = 0;

  const takenDays = (workerId: string, date: string) =>
    approved
      .filter((leave) => leave.workerId === workerId && leave.startDate <= date)
      .reduce((sum, leave) => sum + workingDays(leave.startDate, leave.endDate), 0);

  const balanceRows = (date: string) => workers.map((worker) => {
    const taken = takenDays(worker.id, date);
    const earnedRemaining = Math.max(0, Math.round((earnedDays(worker, date) - taken) * 10) / 10);
    const targetRemaining = Math.max(0, Math.round((demoTargetTakenDays() - taken) * 10) / 10);
    const remaining = Math.min(earnedRemaining, targetRemaining);
    return { ...worker, taken, earnedRemaining, remaining, lastWeek: lastLeaveWeek.get(worker.id) };
  });

  const candidateOrder = (date: string, monday: string, baselineUnfilled: number) => {
    const weekIndex = Math.round((new Date(`${monday}T12:00:00`).getTime() - new Date(`${start}T12:00:00`).getTime()) / (7 * 86400000));
    return balanceRows(date)
      .filter((worker) => worker.remaining >= 5)
      .map((worker) => {
        const last = lastLeaveWeek.get(worker.id);
        const gap = last == null ? 999 : weekIndex - last;
        const recentPenalty = gap < 5 ? 100 : gap < 8 ? 20 : 0;
        return { ...worker, weekIndex, score: worker.remaining - recentPenalty + (baselineUnfilled > 0 ? -5 : 0) };
      })
      .sort((a, b) => b.score - a.score || a.taken - b.taken || a.name.localeCompare(b.name));
  };

  const planFor = (monday: string, extraAbsences: Array<{ workerId: string; startDate: string; endDate: string }>) =>
    generatePlan(restaurant.id, monday, undefined, {
      holidayFilter: ["approved"],
      extraAbsences,
      ignoreAutoServicesForWeek: true,
      maxTier: 1,
    });

  for (let monday = start, weekNo = 0; monday <= end; monday = addDays(monday, 7), weekNo++) {
    const weekEnd = addDays(monday, 6);
    const currentAbsences = approved.filter((leave) => leave.startDate <= weekEnd && leave.endDate >= monday);
    const baseline = await planFor(monday, currentAbsences);
    solves++;
    assertCpsat(baseline, `baseline ${monday}`);

    const baselineUnfilled = unfilled(baseline);
    const baselineWarnings = baseline.complianceWarnings?.length ?? 0;
    let chosen: typeof approved[number] | null = null;
    let chosenPlan: Awaited<ReturnType<typeof generatePlan>> | null = null;

    for (const candidate of candidateOrder(monday, monday, baselineUnfilled).slice(0, workers.length)) {
      const last = lastLeaveWeek.get(candidate.id);
      if (last != null && candidate.weekIndex - last < 5) {
        rejectedRecent++;
        continue;
      }

      const overlapping = approved.filter((leave) => leave.startDate <= weekEnd && leave.endDate >= monday);
      if (overlapping.some((leave) => workers.find((worker) => worker.id === leave.workerId)?.role === candidate.role)) continue;

      const leaveDays = Math.min(candidate.role === "kitchen" ? 3 : 5, candidate.remaining);
      const leave = { workerId: candidate.id, startDate: monday, endDate: addDays(monday, leaveDays - 1) };
      const trial = await planFor(monday, [...overlapping, leave]);
      solves++;
      candidateSolves++;
      assertCpsat(trial, `candidate ${monday} ${candidate.name}`);

      const trialUnfilled = unfilled(trial);
      const trialWarnings = trial.complianceWarnings?.length ?? 0;
      if (planOk(trial) && trialUnfilled <= baselineUnfilled && trialWarnings <= baselineWarnings) {
        chosen = {
          ...leave,
          workerName: candidate.name,
          role: candidate.role,
          remainingBefore: candidate.remaining,
        };
        chosenPlan = trial;
        break;
      }
      rejectedCoverage++;
    }

    const finalPlan = chosenPlan ?? baseline;
    if (chosen) {
      approved.push(chosen);
      lastLeaveWeek.set(chosen.workerId, weekNo);
      const month = chosen.startDate.slice(0, 7);
      monthly.set(month, (monthly.get(month) ?? 0) + 1);
      db.insert(holidayRequests).values({
        workerId: chosen.workerId,
        restaurantId: restaurant.id,
        startDate: chosen.startDate,
        endDate: chosen.endDate,
        reason: "Simulation owner CP-SAT - couverture non degradee.",
        status: "approved",
        source: "admin_proposal",
        reviewedBy: null,
        reviewedAt: chosen.startDate,
      }).run();
      decisions.push({
        week: monday,
        worker: chosen.workerName,
        role: chosen.role,
        remainingBefore: chosen.remainingBefore,
        baselineUnfilled,
        finalUnfilled: unfilled(finalPlan),
      });
    }

    const rows = serviceRows(restaurant.id, finalPlan);
    if (rows.length > 0) db.insert(services).values(rows).run();
    weekSummaries.push({
      week: monday,
      solver: finalPlan.solverUsed,
      status: finalPlan.solverStatus,
      tier: finalPlan.solveTier,
      services: rows.length,
      baselineUnfilled,
      finalUnfilled: unfilled(finalPlan),
      targetSlots: targetSlots(finalPlan),
      approved: chosen?.workerName ?? null,
    });
  }

  const finalBalances = balanceRows(asOf).map((worker) => ({
    name: worker.name,
    role: worker.role,
    earned: earnedDays(worker, asOf),
    taken: worker.taken,
    remainingToTarget: worker.remaining,
    earnedRemaining: worker.earnedRemaining,
  }));
  const impossibleWeeks = weekSummaries.filter((week) => week.finalUnfilled > 0);
  const worsened = decisions.filter((decision) => decision.finalUnfilled > decision.baselineUnfilled);

  const report = {
    restaurant: restaurantName,
    period: { start, end, asOf },
    strictSolver: { fallbackEnabled: process.env.SOLVER_FALLBACK_ENABLED !== "0", required: "cpsat" },
    counts: {
      workers: workers.length,
      weeks: weekSummaries.length,
      solves,
      candidateSolves,
      approvals: approved.length,
      rejectedCoverage,
      rejectedRecent,
    },
    coverage: {
      worsenedByApprovedLeave: worsened.length,
      impossibleWeeks: impossibleWeeks.length,
      maxFinalUnfilled: Math.max(0, ...weekSummaries.map((week) => week.finalUnfilled)),
      totalFinalUnfilled: weekSummaries.reduce((sum, week) => sum + week.finalUnfilled, 0),
      sampleImpossibleWeeks: impossibleWeeks.slice(0, 8),
    },
    distribution: {
      byMonth: [...monthly.entries()].sort().map(([month, count]) => ({ month, count })),
      byWorker: finalBalances.map((worker) => ({
      name: worker.name,
      role: worker.role,
      taken: worker.taken,
      remainingToTarget: worker.remainingToTarget,
      earnedRemaining: worker.earnedRemaining,
    })),
    },
    finalBalances,
    decisions,
  };

  console.log("OWNER_LEAVE_AUDIT_JSON_START");
  console.log(JSON.stringify(report, null, 2));
  console.log("OWNER_LEAVE_AUDIT_JSON_END");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
