// Per-center analysis for fine sweeps.
//
// Fine sweeps from --weights-file label configs as custom_0..N-1, but they actually
// span multiple seed centers stacked into one weights file. This tool slices each
// center into its own group, runs the same summary stats as analyze.ts, and picks
// the per-center winner.
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/analyze-fine.ts \
//     results/fine-v2.jsonl \
//     results/fine-centers.json \
//     --per-center 60

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
    composite: number; passes: boolean;
  };
}

interface Center { name: string; weights: Record<string, number>; }

interface ConfigSummary {
  name: string;
  center: string;
  weights: Record<string, number>;
  totalRuns: number;
  passes: number;
  passRate: number;
  meanComposite: number;
  worstComposite: number;
  compositeStddev: number;
  meanResilience: number;
  meanResilienceRaw: number;
  meanFair: number; meanAdh: number; meanSubrole: number; meanChef: number;
  meanWeekShape: number; meanDowStable: number; meanSpread: number; meanPriority: number;
  meanSolveMs: number;
}

function avg(a: number[]) { return a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length; }
function stddev(a: number[], m: number) { return a.length === 0 ? 0 : Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

async function main() {
  const argv = process.argv.slice(2);
  const jsonlPath = argv[0];
  const centersPath = argv[1];
  if (!jsonlPath || !centersPath) {
    console.error("Usage: bun run analyze-fine.ts <jsonl> <centers.json> [--per-center N] [--export <path>]");
    process.exit(1);
  }
  const get = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const perCenter = Number(get("--per-center", "60"));
  const minPassRate = Number(get("--min-pass-rate", "0.8"));
  const exportPath = get("--export");

  const rows: RunRecord[] = readFileSync(jsonlPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const centers: Center[] = JSON.parse(readFileSync(centersPath, "utf8"));

  const centerOf = (idx: number): string => {
    const c = Math.floor(idx / perCenter);
    return centers[c]?.name ?? `center_${c}`;
  };

  // Group by weightName
  const groups = new Map<string, RunRecord[]>();
  for (const r of rows) {
    if (!groups.has(r.weightName)) groups.set(r.weightName, []);
    groups.get(r.weightName)!.push(r);
  }

  const summaries: ConfigSummary[] = [];
  for (const [name, runs] of groups) {
    const idx = parseInt(name.replace(/^custom_/, ""));
    const center = centerOf(idx);
    const composites = runs.map(r => r.metrics.composite);
    const passes = runs.filter(r => r.metrics.passes).length;
    const meanC = avg(composites);
    summaries.push({
      name, center,
      weights: runs[0].weights,
      totalRuns: runs.length,
      passes, passRate: passes / runs.length,
      meanComposite: meanC,
      worstComposite: Math.min(...composites),
      compositeStddev: stddev(composites, meanC),
      meanResilience: avg(runs.map(r => r.metrics.resilience ?? 0)),
      meanResilienceRaw: avg(runs.map(r => r.metrics.resilienceRaw ?? 0)),
      meanFair: avg(runs.map(r => r.metrics.otFairness)),
      meanAdh: avg(runs.map(r => r.metrics.contractAdherence)),
      meanSubrole: avg(runs.map(r => r.metrics.subroleAccuracy)),
      meanChef: avg(runs.map(r => r.metrics.chefCoverage)),
      meanWeekShape: avg(runs.map(r => r.metrics.weekShape ?? 0)),
      meanDowStable: avg(runs.map(r => r.metrics.dowPatternStability ?? 0)),
      meanSpread: avg(runs.map(r => r.metrics.workloadSpread ?? 0)),
      meanPriority: avg(runs.map(r => r.metrics.priorityUtilization ?? 0)),
      meanSolveMs: avg(runs.map(r => r.solveTimeMs)),
    });
  }

  // Group by center and report per-center top-5 (pass floor + resilience floor).
  const byCenter = new Map<string, ConfigSummary[]>();
  for (const s of summaries) {
    if (!byCenter.has(s.center)) byCenter.set(s.center, []);
    byCenter.get(s.center)!.push(s);
  }

  const passFloor = (s: ConfigSummary) =>
    s.passRate >= minPassRate && s.meanResilienceRaw >= RESILIENCE_FLOOR_RAW;

  const winners: ConfigSummary[] = [];
  for (const [center, group] of byCenter) {
    const ranked = [...group].filter(passFloor).sort((a, b) => b.meanComposite - a.meanComposite);
    console.log(`\n── CENTER: ${center}  (${group.length} configs, ${ranked.length} pass floor) ──`);
    printTable(ranked.slice(0, 5));
    if (ranked[0]) winners.push(ranked[0]);
  }

  console.log(`\n── OVERALL WINNERS (best per center) ──`);
  printTable(winners);

  // Also rank all passes across centers by worst-case (robustness).
  const allPass = summaries.filter(passFloor).sort((a, b) => b.worstComposite - a.worstComposite);
  console.log(`\n── TOP 5 BY WORST-CASE COMPOSITE (cross-center robustness) ──`);
  printTable(allPass.slice(0, 5));

  if (exportPath) {
    writeFileSync(exportPath, JSON.stringify({ byCenter: Object.fromEntries(byCenter), winners }, null, 2));
    console.log(`\nFull per-center export: ${exportPath}`);
  }
}

function printTable(rows: ConfigSummary[]) {
  const H = ["name", "center", "passRate", "meanComp", "worstComp", "stddev", "resRaw", "week", "dow", "fair", "adh", "subr"];
  const w = [10, 34, 9, 9, 10, 7, 7, 6, 6, 6, 6, 6];
  console.log(H.map((h, i) => h.padStart(w[i])).join("  "));
  for (const r of rows) {
    const cells = [
      r.name,
      r.center.slice(0, 32),
      r.passRate.toFixed(2),
      r.meanComposite.toFixed(3),
      r.worstComposite.toFixed(3),
      r.compositeStddev.toFixed(3),
      r.meanResilienceRaw.toFixed(2),
      r.meanWeekShape.toFixed(2),
      r.meanDowStable.toFixed(2),
      r.meanFair.toFixed(2),
      r.meanAdh.toFixed(2),
      r.meanSubrole.toFixed(2),
    ];
    console.log(cells.map((c, i) => c.padStart(w[i])).join("  "));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
