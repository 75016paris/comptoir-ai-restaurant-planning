// Aggregate sweep results: rank weight configs by mean composite, flag instability.
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/analyze.ts results/sweep-coarse.jsonl
//   bun run packages/api/tools/internal/calibrate/analyze.ts results/sweep-coarse.jsonl --top 10 --min-pass-rate 0.8

import { readFileSync, writeFileSync } from "node:fs";
import { RESILIENCE_FLOOR_RAW } from "./metrics.js";

interface RunRecord {
  weightIdx: number;
  weightName: string;
  weights: Record<string, number>;
  restaurant: { id: string };
  scenario: string;
  status: string;
  solveTimeMs: number;
  metrics: {
    fillRate: number; chefCoverage: number; otFairness: number;
    contractAdherence: number; consistency: number; subroleAccuracy: number;
    preferenceMatch: number;
    workloadSpread?: number; priorityUtilization?: number; coupureDiscipline?: number;
    weekShape?: number; dowPatternStability?: number;
    resilience?: number; resilienceRaw?: number;
    costEfficiency?: number; payrollCents?: number;
    composite: number; passes: boolean;
    disqualifyReason?: string;
  };
}

interface ConfigSummary {
  name: string;
  weights: Record<string, number>;
  totalRuns: number;
  passes: number;          // passes hard floor
  passRate: number;
  // Means over all runs (not just passes)
  meanFill: number;
  meanChef: number;
  meanFair: number;
  meanAdh: number;
  meanCons: number;
  meanSubrole: number;
  meanSpread: number;
  meanPriority: number;
  meanCoupure: number;
  meanWeekShape: number;
  meanDowStable: number;
  meanResilience: number;
  meanResilienceRaw: number;
  meanCostEff: number;
  meanPayrollEur: number;
  meanComposite: number;
  // Robustness: stddev of composite across runs (lower = more consistent)
  compositeStddev: number;
  // Worst-case: minimum composite across runs (high = robust)
  worstComposite: number;
  meanSolveMs: number;
}

function summarize(rows: RunRecord[]): ConfigSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of rows) {
    if (!groups.has(r.weightName)) groups.set(r.weightName, []);
    groups.get(r.weightName)!.push(r);
  }

  const out: ConfigSummary[] = [];
  for (const [name, runs] of groups) {
    const passes = runs.filter(r => r.metrics.passes).length;
    const composites = runs.map(r => r.metrics.composite);
    const meanComp = avg(composites);
    out.push({
      name,
      weights: runs[0].weights,
      totalRuns: runs.length,
      passes,
      passRate: passes / runs.length,
      meanFill: avg(runs.map(r => r.metrics.fillRate)),
      meanChef: avg(runs.map(r => r.metrics.chefCoverage)),
      meanFair: avg(runs.map(r => r.metrics.otFairness)),
      meanAdh: avg(runs.map(r => r.metrics.contractAdherence)),
      meanCons: avg(runs.map(r => r.metrics.consistency)),
      meanSubrole: avg(runs.map(r => r.metrics.subroleAccuracy)),
      meanSpread: avg(runs.map(r => r.metrics.workloadSpread ?? 0)),
      meanPriority: avg(runs.map(r => r.metrics.priorityUtilization ?? 0)),
      meanCoupure: avg(runs.map(r => r.metrics.coupureDiscipline ?? 0)),
      meanWeekShape: avg(runs.map(r => r.metrics.weekShape ?? 0)),
      meanDowStable: avg(runs.map(r => r.metrics.dowPatternStability ?? 0)),
      meanResilience: avg(runs.map(r => r.metrics.resilience ?? 0)),
      meanResilienceRaw: avg(runs.map(r => r.metrics.resilienceRaw ?? 0)),
      meanCostEff: avg(runs.map(r => r.metrics.costEfficiency ?? 0.5)),
      meanPayrollEur: avg(runs.map(r => (r.metrics.payrollCents ?? 0) / 100)),
      meanComposite: meanComp,
      compositeStddev: stddev(composites, meanComp),
      worstComposite: Math.min(...composites),
      meanSolveMs: avg(runs.map(r => r.solveTimeMs)),
    });
  }
  return out;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[], mean: number): number {
  if (arr.length === 0) return 0;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

async function main() {
  const argv = process.argv.slice(2);
  const path = argv[0];
  if (!path) {
    console.error("Usage: bun run analyze.ts <jsonl-path> [--top N] [--min-pass-rate R] [--export <path>]");
    process.exit(1);
  }
  const get = (flag: string, fallback?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const topN = Number(get("--top", "10"));
  const minPassRate = Number(get("--min-pass-rate", "0.6"));
  const exportPath = get("--export");
  const sortBy = get("--sort", "composite"); // "composite" | "cost"
  // Config-level resilience floor: disqualify presets whose aggregate raw backup count
  // falls below 0.5 (= less than one backup per shift on average). Opt-out with --no-res-floor.
  const enforceResFloor = !argv.includes("--no-res-floor");

  const text = readFileSync(path, "utf8");
  const rows: RunRecord[] = text.trim().split("\n").map(l => JSON.parse(l));
  const summaries = summarize(rows);

  // Two rankings: by mean composite (peak) and by worst-case composite (robust).
  const passFloor = (s: ConfigSummary) =>
    s.passRate >= minPassRate && (!enforceResFloor || s.meanResilienceRaw >= RESILIENCE_FLOOR_RAW);
  const byMean = [...summaries].filter(passFloor).sort((a, b) =>
    sortBy === "cost"
      ? (b.meanCostEff - a.meanCostEff) || (b.meanComposite - a.meanComposite)
      : (b.meanComposite - a.meanComposite)
  );
  const byWorst = [...summaries].filter(passFloor).sort((a, b) => b.worstComposite - a.worstComposite);
  const resDropped = summaries.filter(s => s.passRate >= minPassRate && enforceResFloor && s.meanResilienceRaw < RESILIENCE_FLOOR_RAW);
  if (resDropped.length > 0) {
    console.log(`\n${resDropped.length} configs filtered by resilience floor (mean raw backup < ${RESILIENCE_FLOOR_RAW}):`);
    for (const s of resDropped.slice(0, 10)) {
      console.log(`  ${s.name.padEnd(16)}  resRaw=${s.meanResilienceRaw.toFixed(2)}  composite=${s.meanComposite.toFixed(3)}`);
    }
  }

  console.log(`\n${rows.length} runs across ${summaries.length} weight configs`);
  console.log(`(pass-rate floor for ranking: ${minPassRate})\n`);

  console.log(`── TOP ${topN} BY MEAN COMPOSITE ──`);
  printTable(byMean.slice(0, topN));

  console.log(`\n── TOP ${topN} BY WORST-CASE COMPOSITE (most robust) ──`);
  printTable(byWorst.slice(0, topN));

  // Default reference for comparison.
  const def = summaries.find(s => s.name === "default");
  if (def) {
    console.log(`\n── DEFAULT (reference) ──`);
    printTable([def]);
  }

  if (exportPath) {
    writeFileSync(exportPath, JSON.stringify({ byMean, byWorst, default: def }, null, 2));
    console.log(`\nFull rankings exported to ${exportPath}`);
  }
}

function printTable(rows: ConfigSummary[]) {
  const headers = ["name", "passRate", "meanComp", "worstComp", "stddev", "cost", "€payroll", "res", "week", "dow", "spread", "prio", "fair", "adh", "subr", "chef", "ms"];
  const w = [16, 8, 9, 10, 7, 6, 9, 5, 6, 6, 7, 6, 6, 6, 6, 6, 6];
  console.log(headers.map((h, i) => h.padStart(w[i])).join("  "));
  for (const r of rows) {
    const cells = [
      r.name,
      r.passRate.toFixed(2),
      r.meanComposite.toFixed(3),
      r.worstComposite.toFixed(3),
      r.compositeStddev.toFixed(3),
      r.meanCostEff.toFixed(3),
      Math.round(r.meanPayrollEur).toString(),
      r.meanResilience.toFixed(2),
      r.meanWeekShape.toFixed(2),
      r.meanDowStable.toFixed(2),
      r.meanSpread.toFixed(2),
      r.meanPriority.toFixed(2),
      r.meanFair.toFixed(2),
      r.meanAdh.toFixed(2),
      r.meanSubrole.toFixed(2),
      r.meanChef.toFixed(2),
      Math.round(r.meanSolveMs).toString(),
    ];
    console.log(cells.map((c, i) => c.padStart(w[i])).join("  "));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
