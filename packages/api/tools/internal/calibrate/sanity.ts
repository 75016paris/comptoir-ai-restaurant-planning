// Side-by-side before/after comparison of current DEFAULT_WEIGHTS vs the
// legacy hand-tuned defaults (pre-calibration). Runs the same scenarios with
// both weight sets and prints what changed.

import { generateRestaurant, sampleAxes } from "./generate.js";
import { buildScenario, type ScenarioName } from "./scenarios.js";
import { computeMetrics } from "./metrics.js";
import { solveCPSAT } from "../../../src/utils/cpsat-solver.js";
import { DEFAULT_WEIGHTS, type WeightConfig } from "@comptoir/shared";

// Old hand-tuned defaults (pre-calibration) for comparison.
const OLD_DEFAULTS: WeightConfig = {
  fill: 1000, bucket0Value: 80, bucket1Value: 20, bucket2Penalty: 40, bucket3Penalty: 100,
  bucket2OtOffset: 0.7, bucket3OtOffset: 0.5,
  consistency: 5, preference: 3, priority: 2, flexibility: 1,
  subroleMismatch: 800, rolePenalty: 500,
};

interface RunOut {
  workers: number;
  assignments: number;
  obj: number | undefined;
  solveMs: number;
  status: string;
  metrics: ReturnType<typeof computeMetrics>;
  hoursByWorker: Map<string, number>;
  otByWorker: Map<string, number>;
}

async function run(rIdx: number, label: string, scenario: ScenarioName, weights: WeightConfig): Promise<RunOut> {
  const axes = sampleAxes(42, 15);
  const r = generateRestaurant(axes[rIdx].seed, axes[rIdx]);
  const inputs = buildScenario(r, scenario);
  const res = await solveCPSAT(inputs.workers, inputs.slots, r.ilpConfig, inputs.checker, inputs.multiWeek, undefined, weights);
  const m = computeMetrics(inputs, res);

  const slotsById = new Map(inputs.slots.map(s => [s.id, s]));
  const hoursByWorker = new Map<string, number>();
  const otByWorker = new Map<string, number>();
  const numWeeks = inputs.multiWeek?.numWeeks ?? 1;
  for (const a of res.assignments) {
    const slot = slotsById.get(a.slotId);
    if (!slot) continue;
    hoursByWorker.set(a.workerId, (hoursByWorker.get(a.workerId) ?? 0) + slot.hours);
  }
  for (const w of inputs.workers) {
    const hrs = hoursByWorker.get(w.id) ?? 0;
    const ot = Math.max(0, hrs - w.contractHours * numWeeks);
    if (ot > 0) otByWorker.set(w.id, ot);
  }
  return {
    workers: inputs.workers.length,
    assignments: res.assignments.length,
    obj: res.objectiveValue,
    solveMs: res.solveTimeMs,
    status: res.status,
    metrics: m,
    hoursByWorker,
    otByWorker,
  };
}

async function compare(rIdx: number, scenario: ScenarioName) {
  const axes = sampleAxes(42, 15);
  const cfg = axes[rIdx];
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`Restaurant r42n${rIdx}: size=${cfg.teamSize} complex=${cfg.serviceComplexity} hier=${cfg.subroleHierarchy}  |  Scenario: ${scenario}`);
  console.log(`═══════════════════════════════════════════════════════════════`);

  const [before, after] = await Promise.all([
    run(rIdx, "OLD", scenario, OLD_DEFAULTS),
    run(rIdx, "cur", scenario, DEFAULT_WEIGHTS),
  ]);

  console.log(`Solver stats:`);
  console.log(`  OLD defaults: ${before.status.padEnd(10)} assigns=${before.assignments} obj=${before.obj?.toFixed(0) ?? "—"} time=${before.solveMs.toFixed(0)}ms`);
  console.log(`  current:   ${after.status.padEnd(10)} assigns=${after.assignments} obj=${after.obj?.toFixed(0) ?? "—"} time=${after.solveMs.toFixed(0)}ms`);

  console.log(`\nMetrics comparison:`);
  const m1 = before.metrics, m2 = after.metrics;
  const rows = [
    ["Composite",         m1.composite, m2.composite],
    ["Fill rate",         m1.fillRate,  m2.fillRate],
    ["OT fairness",       m1.otFairness, m2.otFairness],
    ["Contract adherence",m1.contractAdherence, m2.contractAdherence],
    ["Workload spread",   m1.workloadSpread, m2.workloadSpread],
    ["Priority util",     m1.priorityUtilization, m2.priorityUtilization],
    ["Consistency",       m1.consistency, m2.consistency],
    ["Chef coverage",     m1.chefCoverage, m2.chefCoverage],
    ["Sub-role accuracy", m1.subroleAccuracy, m2.subroleAccuracy],
    ["Week shape",        m1.weekShape, m2.weekShape],
    ["Dow stability",     m1.dowPatternStability, m2.dowPatternStability],
  ];
  for (const [name, a, b] of rows) {
    const delta = (b as number) - (a as number);
    const arrow = Math.abs(delta) < 0.005 ? "  " : (delta > 0 ? "▲" : "▼");
    console.log(`  ${(name as string).padEnd(20)}  OLD=${(a as number).toFixed(3)}   cur=${(b as number).toFixed(3)}   ${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`);
  }

  console.log(`\nOT distribution:`);
  const otListOld = [...before.otByWorker.values()].sort((a, b) => b - a);
  const otListNew = [...after.otByWorker.values()].sort((a, b) => b - a);
  console.log(`  OLD defaults: ${before.otByWorker.size} workers over contract. Max OT per worker: ${otListOld[0]?.toFixed(0) ?? 0}h. Total OT: ${otListOld.reduce((s, v) => s + v, 0).toFixed(0)}h`);
  console.log(`  current:   ${after.otByWorker.size} workers over contract. Max OT per worker: ${otListNew[0]?.toFixed(0) ?? 0}h. Total OT: ${otListNew.reduce((s, v) => s + v, 0).toFixed(0)}h`);
  if (otListOld.length && otListNew.length) {
    console.log(`  → current ${after.otByWorker.size > before.otByWorker.size ? "spreads OT across more workers" : after.otByWorker.size < before.otByWorker.size ? "concentrates OT on fewer workers" : "uses the same number of OT workers"}, max OT ${otListNew[0] < otListOld[0] ? "down" : otListNew[0] > otListOld[0] ? "up" : "same"}`);
  }
}

async function main() {
  process.env.CPSAT_SOLVER_URL = "http://62.210.195.137:8090";
  process.env.CPSAT_TIMEOUT = "15";

  // r42n2 is size-15 kitchen-heavy single-service → Chez-Reno-shaped
  // r42n4 is size-30 three-zone four-tier → Grand-Brasserie-shaped
  // Also check r42n1 (size-50) for larger scale
  const cases: Array<[number, ScenarioName]> = [
    [2, "clean"],
    [2, "holiday-cluster"],
    [4, "clean"],
    [4, "demand-spike"],
    [1, "clean"],
  ];
  for (const [idx, sc] of cases) {
    await compare(idx, sc);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
