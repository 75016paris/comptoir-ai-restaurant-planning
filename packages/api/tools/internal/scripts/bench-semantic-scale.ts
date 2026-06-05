/**
 * Benchmark the SEMANTIC_SCALE ordinal values defined in packages/shared/src/weight-config.ts.
 *
 * Runs a focused matrix of CP-SAT solves against a reference restaurant:
 *  1. Each (dimension, level) individually (55 solves)
 *  2. The 5 named presets as-is (5 solves)
 *  3. Adversarial combinations that could over-constrain the model
 *  4. Degenerate checks: Level 0 on every dim should still solve
 *
 * For each solve, records: status, fill rate, total hours, OT hours,
 * sub-role mismatches, worker-hour variance. Output: markdown report to stdout.
 *
 * Usage:
 *   SOLVER=cpsat CPSAT_SOLVER_URL=http://62.210.195.137:8090 \
 *     DATABASE_URL=/path/to/comptoir.db \
 *     bun scripts/bench-semantic-scale.ts \
 *     [--restaurant=<id>] [--weeks=1] [--full]
 */

import {
  DEFAULT_WEIGHTS,
  DIMENSION_META,
  PRESETS,
  resolvePreset,
  resolveWeights,
  type WeightConfig,
  type TunableDimension,
  type SemanticLevel,
  type CustomWeights,
} from "@comptoir/shared";
import { runMultiWeekSolve } from "../../../src/services/multi-week-solver.js";
import { db } from "../../../src/db/connection.js";
import { services, users, staffingTargets, staffingProfiles, restaurants } from "../../../src/db/schema.js";
import { eq, and } from "drizzle-orm";
import { fmtDate, getMonday } from "../../../src/utils/scheduling.js";

// ── CLI args ──
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
);
const RESTAURANT_ID = (args.restaurant as string) || process.env.BENCH_RESTAURANT_ID || "6ff8c361-5a74-42a1-9de9-584606ef332e";
const NUM_WEEKS = Number((args.weeks as string) || process.env.BENCH_WEEKS || "1");
const FULL = args.full === "true";
// Scenario mode — "balanced" (default) uses real team; "understaffed" slashes contracts by 30%
// to force the solver into OT/priority territory so those dimensions become observable.
const SCENARIO = (args.scenario as string) || "balanced";
const CONTRACT_SCALE = SCENARIO === "understaffed" ? 0.7 : 1.0;

// ── Setup: reference monday — 8 weeks out to guarantee a greenfield week
// (no pre-existing services that would pin the solver and mask weight effects). ──
const refDate = fmtDate((() => { const d = new Date(); d.setDate(d.getDate() + 56 - d.getDay() + 1); return d; })());
const BASE_MONDAY = getMonday(refDate);

// ── Metrics ──
type BenchResult = {
  label: string;
  status: string;
  solveTimeMs: number;
  assignmentCount: number;
  kitchenFill: string;       // "40/40"
  salleFill: string;
  totalHours: number;
  otHours: number;           // hours > 35 per worker
  subRoleMismatchCount: number;
  workerHoursStddev: number; // fairness proxy
  error?: string;
};

type WorkerRow = { id: string; role: string; contractHours: number | null; subRoles: string | null };

async function computeMetrics(label: string, weights: WeightConfig, profileIdOverride: string, contractOverrides?: Record<string, number>): Promise<BenchResult> {
  const t0 = Date.now();
  try {
    const result = await runMultiWeekSolve(
      RESTAURANT_ID,
      BASE_MONDAY,
      NUM_WEEKS,
      { profileIdOverride, contractOverrides },
      undefined,
      weights,
    );
    const { ilpResult, mergedSlots } = result;

    // Fill per role: aggregate (existing DB services + new ILP assignments) per (week, dow, role, zone)
    const slotMap = new Map(mergedSlots.map(s => [s.id, s]));
    const targetByKey = new Map<string, { role: string; target: number; existingFill: number }>();
    for (const s of mergedSlots) {
      const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
      // For compound halves, both rows share the same key; keep the larger existingFill (they mirror)
      const prev = targetByKey.get(key);
      if (!prev) targetByKey.set(key, { role: s.role, target: s.target, existingFill: s.existingFill });
      else prev.existingFill = Math.max(prev.existingFill, s.existingFill);
    }
    const newFillByKey = new Map<string, Set<string>>();
    for (const a of ilpResult.assignments) {
      const s = slotMap.get(a.slotId);
      if (!s) continue;
      const key = `${s.week ?? 0}_${s.dow}_${s.role}_${s.zone}`;
      if (!newFillByKey.has(key)) newFillByKey.set(key, new Set());
      newFillByKey.get(key)!.add(a.workerId);
    }
    let kTotal = 0, kFilled = 0, sTotal = 0, sFilled = 0;
    for (const [key, { role, target, existingFill }] of targetByKey) {
      const newFill = newFillByKey.get(key)?.size || 0;
      const total = Math.min(existingFill + newFill, target);
      if (role === "kitchen") { kTotal += target; kFilled += total; }
      else { sTotal += target; sFilled += total; }
    }

    // Worker hours + OT
    let totalHours = 0, otHours = 0;
    const perWorker: number[] = [];
    if (ilpResult.perWeekWorkerHours) {
      for (const [, weekly] of ilpResult.perWeekWorkerHours) {
        // average per week → treat as "weekly hours" for this worker
        const avg = weekly.reduce((a, b) => a + b, 0) / weekly.length;
        perWorker.push(avg);
        totalHours += avg;
        if (avg > 35) otHours += avg - 35;
      }
    }
    // Stddev as fairness proxy
    let stddev = 0;
    if (perWorker.length > 1) {
      const mean = totalHours / perWorker.length;
      stddev = Math.sqrt(perWorker.reduce((s, v) => s + (v - mean) ** 2, 0) / perWorker.length);
    }

    // Sub-role mismatch: count assignments where worker's subroles don't include any breakdown key the slot declares
    // Slot role-breakdown is attached via mergedSlots[].roleBreakdown (a Record<subrole, count>)
    // If a slot has a breakdown {Chef:1} and an assignment comes from a worker whose subRoles is []
    // or ["Plongeur"], that counts as a mismatch.
    const workerSubroles = new Map<string, string[]>();
    const workerRows = db.select({ id: users.id, subRoles: users.subRoles }).from(users).where(eq(users.restaurantId, RESTAURANT_ID)).all();
    for (const w of workerRows) {
      try {
        const list = w.subRoles ? (JSON.parse(w.subRoles) as string[]) : [];
        workerSubroles.set(w.id, list);
      } catch { workerSubroles.set(w.id, []); }
    }
    let mismatches = 0;
    // Aggregate worker → slot-key counts
    const byKey = new Map<string, Array<{ workerId: string; subRoles: string[] }>>();
    for (const a of ilpResult.assignments) {
      const s = slotMap.get(a.slotId);
      if (!s) continue;
      const breakdown = (s as any).roleBreakdown;
      if (!breakdown || typeof breakdown !== "object" || Object.keys(breakdown).length === 0) continue;
      const key = `${s.week}_${s.dow}_${s.role}_${s.zone}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({ workerId: a.workerId, subRoles: workerSubroles.get(a.workerId) || [] });
    }
    // For each slot group, check if the worker pool covers the breakdown. Count unmet demand.
    for (const [key, assigns] of byKey) {
      const slot = mergedSlots.find(s => `${s.week}_${s.dow}_${s.role}_${s.zone}` === key);
      const breakdown = slot ? (slot as any).roleBreakdown : null;
      if (!breakdown) continue;
      for (const [sr, need] of Object.entries(breakdown as Record<string, number>)) {
        const have = assigns.filter(a => a.subRoles.includes(sr)).length;
        if (have < need) mismatches += (need - have);
      }
    }

    return {
      label,
      status: ilpResult.status,
      solveTimeMs: Math.round(ilpResult.solveTimeMs),
      assignmentCount: ilpResult.assignments.length,
      kitchenFill: `${kFilled}/${kTotal}`,
      salleFill: `${sFilled}/${sTotal}`,
      totalHours: Math.round(totalHours),
      otHours: Math.round(otHours * 10) / 10,
      subRoleMismatchCount: mismatches,
      workerHoursStddev: Math.round(stddev * 10) / 10,
    };
  } catch (e: any) {
    return {
      label,
      status: "error",
      solveTimeMs: Date.now() - t0,
      assignmentCount: 0,
      kitchenFill: "-",
      salleFill: "-",
      totalHours: 0,
      otHours: 0,
      subRoleMismatchCount: 0,
      workerHoursStddev: 0,
      error: e?.message || String(e),
    };
  }
}

// ── Test matrix ──
function buildTests(): Array<{ label: string; weights: WeightConfig; group: string }> {
  const tests: Array<{ label: string; weights: WeightConfig; group: string }> = [];

  // (1) Each dimension, each level
  for (const dim of DIMENSION_META) {
    for (let lvl = 0; lvl <= 4; lvl++) {
      tests.push({
        group: "single",
        label: `${dim.key}=L${lvl}`,
        weights: resolveWeights("equilibre", { [dim.key]: lvl } as CustomWeights),
      });
    }
  }

  // (2) Named presets
  for (const [name, w] of Object.entries(PRESETS)) {
    tests.push({ group: "preset", label: `preset:${name}`, weights: w });
  }

  // (3) Adversarial combos
  const combos: Array<{ label: string; ov: CustomWeights }> = [
    { label: "rigid-everything",       ov: { rolePenalty: 4, subroleMismatch: 4, flexibility: 4 } },
    { label: "block-all-ot",           ov: { bucket3Penalty: 4, bucket2Penalty: 4, otOffset: 0 } },
    { label: "must-consistency",       ov: { consistency: 4, preference: 4, priority: 4 } },
    { label: "let-it-slide",           ov: { rolePenalty: 0, subroleMismatch: 0, bucket3Penalty: 0 } },
    { label: "stable-team-max",        ov: { consistency: 4, preference: 4 } },
    { label: "flat-priority",          ov: { priority: 0, flexibility: 0 } },
    { label: "flex-cross-role",        ov: { subroleMismatch: 0, rolePenalty: 0, flexibility: 4 } },
    { label: "ot-soak-max",            ov: { bucket1Value: 4, bucket2Penalty: 0, bucket3Penalty: 0, otOffset: 4 } },
    { label: "contract-hard-strict",   ov: { bucket0Value: 4, bucket2Penalty: 4, bucket3Penalty: 4 } },
  ];
  for (const c of combos) {
    tests.push({ group: "combo", label: `combo:${c.label}`, weights: resolveWeights("equilibre", c.ov) });
  }

  return tests;
}

async function main() {
  console.log(`# Semantic scale benchmark`);
  console.log(``);
  console.log(`- Restaurant: \`${RESTAURANT_ID}\``);
  console.log(`- Weeks: ${NUM_WEEKS}`);
  console.log(`- Base monday: ${BASE_MONDAY}`);
  console.log(`- Solver: ${process.env.SOLVER || "(default)"}`);
  console.log(`- Started: ${new Date().toISOString()}`);
  console.log(``);

  // Pick active profile for the restaurant
  const profiles = db.select({ id: staffingProfiles.id, name: staffingProfiles.name })
    .from(staffingProfiles)
    .where(eq(staffingProfiles.restaurantId, RESTAURANT_ID))
    .orderBy(staffingProfiles.sortOrder)
    .all();
  const activeProfileId = profiles[0]?.id;
  if (!activeProfileId) throw new Error(`No staffing profile for restaurant ${RESTAURANT_ID}`);
  console.log(`- Profile: ${profiles[0].name} (${activeProfileId})`);
  console.log(``);

  // Quick restaurant summary
  const workers = db.select({ id: users.id, role: users.role, contractHours: users.contractHours })
    .from(users)
    .where(and(eq(users.restaurantId, RESTAURANT_ID), eq(users.active, 1 as unknown as boolean)))
    .all();
  const kitchenCount = workers.filter(w => w.role === "kitchen").length;
  const salleCount = workers.filter(w => w.role === "floor").length;
  const totalContract = workers.reduce((s, w) => s + (w.contractHours ?? 35), 0);
  console.log(`- Team: ${kitchenCount} cuisine + ${salleCount} salle = ${workers.length} workers, ${totalContract}h contract total`);
  console.log(`- Scenario: **${SCENARIO}**${CONTRACT_SCALE !== 1.0 ? ` (contracts scaled to ${Math.round(CONTRACT_SCALE * 100)}%)` : ""}`);
  console.log(``);

  // Contract overrides for understaffed scenario
  const contractOverrides: Record<string, number> | undefined = CONTRACT_SCALE !== 1.0
    ? Object.fromEntries(workers.map(w => [w.id, Math.round((w.contractHours ?? 35) * CONTRACT_SCALE)]))
    : undefined;

  const tests = buildTests();
  console.log(`## Running ${tests.length} scenarios (~${Math.round(tests.length * 2)}s estimated)`);
  console.log(``);

  // Compute baseline separately (equilibre as-is) for percentage comparisons
  const baselineResult = await computeMetrics("baseline:equilibre", resolvePreset("equilibre"), activeProfileId, contractOverrides);
  console.log(`## Baseline (equilibre)`);
  console.log(``);
  console.log(`- Status: **${baselineResult.status}** (${baselineResult.solveTimeMs}ms)`);
  console.log(`- Fill: cuisine ${baselineResult.kitchenFill}, salle ${baselineResult.salleFill}`);
  console.log(`- Total hours: ${baselineResult.totalHours}, OT: ${baselineResult.otHours}, mismatch: ${baselineResult.subRoleMismatchCount}, stddev: ${baselineResult.workerHoursStddev}`);
  console.log(``);

  const results: BenchResult[] = [baselineResult];

  // Group helpers
  const byGroup = new Map<string, Array<{ label: string; weights: WeightConfig }>>();
  for (const t of tests) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group)!.push({ label: t.label, weights: t.weights });
  }

  for (const [group, groupTests] of byGroup) {
    console.log(`## ${group} (${groupTests.length} solves)`);
    console.log(``);
    console.log(`| Label | Status | Cuisine fill | Salle fill | Hours | OT | Mismatch | Stddev | Solve |`);
    console.log(`|-------|--------|-------------|-----------|-------|----|---------|-------|-------|`);
    for (const t of groupTests) {
      const r = await computeMetrics(t.label, t.weights, activeProfileId, contractOverrides);
      results.push(r);
      console.log(`| ${r.label} | ${r.status === "optimal" ? "✓" : r.status} | ${r.kitchenFill} | ${r.salleFill} | ${r.totalHours} | ${r.otHours} | ${r.subRoleMismatchCount} | ${r.workerHoursStddev} | ${r.solveTimeMs}ms |`);
    }
    console.log(``);
  }

  // ── Analysis ──
  console.log(`## Analysis`);
  console.log(``);

  // Infeasibility
  const infeasible = results.filter(r => r.status === "infeasible" || r.status === "error");
  if (infeasible.length > 0) {
    console.log(`### ⚠ Infeasible / errored (${infeasible.length})`);
    for (const r of infeasible) console.log(`- \`${r.label}\` → ${r.status}${r.error ? ` — ${r.error}` : ""}`);
    console.log(``);
  } else {
    console.log(`### ✓ All scenarios feasible.`);
    console.log(``);
  }

  // Degenerate (same fill + hours as baseline across all 5 levels for a given dimension)
  console.log(`### Degenerate dimensions (no effect across L0..L4)`);
  const base = baselineResult;
  const degenerate: string[] = [];
  for (const dim of DIMENSION_META) {
    const dimResults = results.filter(r => r.label.startsWith(`${dim.key}=L`));
    if (dimResults.length !== 5) continue;
    const uniq = new Set(dimResults.map(r => `${r.kitchenFill}|${r.salleFill}|${r.totalHours}|${r.otHours}|${r.subRoleMismatchCount}`));
    if (uniq.size === 1) degenerate.push(dim.key);
  }
  if (degenerate.length === 0) console.log(`*None — every dimension changes the solve output at some level.*`);
  else for (const d of degenerate) console.log(`- \`${d}\` — all 5 levels produce identical metrics`);
  console.log(``);

  // Strong deviation (> 40% OT or fill change from baseline)
  console.log(`### Large deviations (|ΔOT| > 40% or |Δfill| > 10%)`);
  const baseFillK = parseFillRate(base.kitchenFill);
  const baseFillS = parseFillRate(base.salleFill);
  const baseOt = Math.max(1, base.otHours);
  const anomalies: string[] = [];
  for (const r of results) {
    if (r.status !== "optimal") continue;
    if (r.label === base.label) continue;
    const fK = parseFillRate(r.kitchenFill);
    const fS = parseFillRate(r.salleFill);
    const fKdiff = Math.abs(fK - baseFillK);
    const fSdiff = Math.abs(fS - baseFillS);
    const otPct = Math.abs(r.otHours - base.otHours) / baseOt;
    if (fKdiff > 0.1 || fSdiff > 0.1 || otPct > 0.4) {
      anomalies.push(`- \`${r.label}\` — cuisine ${r.kitchenFill} (Δ${(fKdiff * 100).toFixed(0)}%), salle ${r.salleFill} (Δ${(fSdiff * 100).toFixed(0)}%), OT ${r.otHours}h (Δ${(otPct * 100).toFixed(0)}%)`);
    }
  }
  if (anomalies.length === 0) console.log(`*None — all scenarios land within ±10% fill and ±40% OT of baseline.*`);
  else for (const a of anomalies) console.log(a);
  console.log(``);

  console.log(`## Done`);
  console.log(`- Completed: ${new Date().toISOString()}`);
  console.log(`- Total scenarios: ${results.length}`);
  console.log(`- Wall time: ${results.reduce((s, r) => s + r.solveTimeMs, 0)}ms`);
}

function parseFillRate(s: string): number {
  const [a, b] = s.split("/").map(Number);
  return b > 0 ? a / b : 0;
}

main().catch(e => {
  console.error("BENCH FAILED:", e?.message || e, "\n", e?.stack);
  process.exit(1);
});
