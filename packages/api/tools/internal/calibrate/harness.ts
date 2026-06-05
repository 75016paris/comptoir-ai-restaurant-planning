// Calibration harness CLI.
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/harness.ts \
//     --restaurants 30 --scenarios all --grid coarse \
//     --solver-url http://62.210.195.137:8090 \
//     --concurrency 4 --output results/sweep-coarse.jsonl
//
// Each output line: {weightIdx, weightName, restaurant, scenario, metrics, solveTimeMs, status}.

import { mkdir, appendFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { solveCPSAT } from "../../../src/utils/cpsat-solver.js";
import { slotKey, type HintAssignment } from "../../../src/services/hint-store.js";
import { sampleAxes, generateRestaurant, type RestaurantConfig } from "./generate.js";
import { buildScenario, SCENARIOS, setScenarioWeeks, type ScenarioName } from "./scenarios.js";
import { computeMetrics } from "./metrics.js";
import { coarseGrid, costGrid, fineGrid } from "./weight-grids.js";
import { DEFAULT_WEIGHTS, PRESETS, type WeightConfig } from "@comptoir/shared";

interface Args {
  restaurants: number;
  scenarios: ScenarioName[] | "all";
  grid: "coarse" | "cost" | "presets" | "single" | "default" | "fine";
  solverUrl: string;
  concurrency: number;
  output: string;
  axesSeed: number;
  timeout: number;         // CP-SAT seconds per solve
  weeks: number;           // planning horizon (weeks); default 4, production uses 12
  weightsFile?: string;    // optional JSON of WeightConfig[] (overrides --grid)
  fineCenter?: string;     // path to single WeightConfig (JSON) around which fineGrid generates perturbations
  fineCount?: number;      // how many fine configs to generate
  limit?: number;          // optional cap on total solves (smoke testing)
  weightsRange?: [number, number]; // inclusive:exclusive slice of the built weight grid, for partial re-runs
  preset?: string;         // with --grid presets, run only this preset name
  warmStart: boolean;      // solve each fixture twice; feed first result as AddHint into second
  // Overrides weights.templateMatch for the warm pass only. Cold pass always
  // runs with the preset's default (0 for équipe-stable until Step 2 ships).
  // Enables the magnitude sweep {30, 60, 120, 200} without editing the preset
  // between runs. Implies --warm-start (template is derived from the cold pass).
  templateMatchWeight?: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string) => {
    // Support both "--flag value" and "--flag=value" forms.
    const eqPrefix = `${flag}=`;
    for (const a of argv) {
      if (a.startsWith(eqPrefix)) return a.slice(eqPrefix.length);
    }
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const restaurants = Number(get("--restaurants", "10"));
  const scenariosRaw = get("--scenarios", "all")!;
  const scenarios: Args["scenarios"] = scenariosRaw === "all"
    ? "all"
    : (scenariosRaw.split(",").filter(s => (SCENARIOS as readonly string[]).includes(s)) as ScenarioName[]);
  const grid = (get("--grid", "coarse") as Args["grid"]);
  const solverUrl = get("--solver-url", process.env.CPSAT_SOLVER_URL || "http://localhost:8090")!;
  const concurrency = Number(get("--concurrency", "4"));
  const output = get("--output", `packages/api/tools/internal/calibrate/results/sweep-${Date.now()}.jsonl`)!;
  const axesSeed = Number(get("--axes-seed", "42"));
  const timeout = Number(get("--timeout", "10"));
  const weeks = Number(get("--weeks", "4"));
  const weightsFile = get("--weights-file");
  const fineCenter = get("--fine-center");
  const fineCount = get("--fine-count") ? Number(get("--fine-count")) : 60;
  const limit = get("--limit") ? Number(get("--limit")) : undefined;
  const rangeArg = get("--weights-range");
  let weightsRange: [number, number] | undefined;
  if (rangeArg) {
    const [a, b] = rangeArg.split(":").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) throw new Error(`bad --weights-range "${rangeArg}", want e.g. 19:43`);
    weightsRange = [a, b];
  }
  const preset = get("--preset");
  let warmStart = argv.includes("--warm-start");
  const tmwRaw = get("--template-match-weight");
  const templateMatchWeight = tmwRaw !== undefined ? Number(tmwRaw) : undefined;
  if (templateMatchWeight !== undefined) {
    if (!Number.isFinite(templateMatchWeight) || templateMatchWeight < 0) {
      throw new Error(`bad --template-match-weight "${tmwRaw}", want a non-negative number`);
    }
    warmStart = true; // template is derived from the cold pass — warm-start is mandatory here.
  }
  return { restaurants, scenarios, grid, solverUrl, concurrency, output, axesSeed, timeout, weeks, weightsFile, fineCenter, fineCount, limit, weightsRange, preset, warmStart, templateMatchWeight };
}

interface Job {
  weightIdx: number;
  weightName: string;
  weights: WeightConfig;
  restaurant: RestaurantConfig;
  scenario: ScenarioName;
}

async function solveOnce(
  inputs: ReturnType<typeof buildScenario>,
  ilpConfig: any,
  weights: WeightConfig,
  hints: HintAssignment[] | undefined,
  dowTemplates: Map<string, Set<number>> | undefined,
) {
  const t0 = performance.now();
  try {
    const result = await solveCPSAT(
      inputs.workers, inputs.slots, ilpConfig, inputs.checker,
      inputs.multiWeek, undefined, weights, hints, dowTemplates,
    );
    return { result, error: undefined as string | undefined };
  } catch (e: any) {
    return {
      result: {
        status: "error" as const,
        assignments: [],
        solveTimeMs: performance.now() - t0,
        stats: { variables: 0, constraints: 0, workers: inputs.workers.length, slots: inputs.slots.length },
      },
      error: e?.message ?? String(e),
    };
  }
}

async function runJob(job: Job, warmStart: boolean, templateMatchWeight: number | undefined): Promise<any> {
  const r = generateRestaurant(job.restaurant.seed, job.restaurant);
  const inputs = buildScenario(r, job.scenario);

  // Cold solve (baseline, no hints, no template — template-match stays at preset
  // default, which is 0 for every preset except équipe-stable; and even for
  // équipe-stable, without dowTemplates the term is a no-op).
  const cold = await solveOnce(inputs, r.ilpConfig, job.weights, undefined, undefined);
  const coldMetrics = computeMetrics(inputs, cold.result);

  // Warm solve: feed cold's assignments in as AddHint, derive a dow template
  // from them, and (optionally) override weights.templateMatch for the warm
  // pass only. Only when cold produced usable output — infeasible/error
  // carries no signal for the hint store or the template.
  let warm: { result: any; error: string | undefined } | undefined;
  let warmMetrics: ReturnType<typeof computeMetrics> | undefined;
  let hintsProvided = 0;
  let templateWorkers = 0;
  let templateDowTotal = 0;
  if (warmStart && (cold.result.status === "optimal" || cold.result.status === "feasible") && cold.result.assignments.length > 0) {
    const slotById = new Map(inputs.slots.map(s => [s.id, s]));
    const hints: HintAssignment[] = [];
    const dowTemplates = new Map<string, Set<number>>();
    for (const a of cold.result.assignments) {
      const s = slotById.get(a.slotId);
      if (!s) continue;
      hints.push({ workerId: a.workerId, slotKey: slotKey(s) });
      let set = dowTemplates.get(a.workerId);
      if (!set) { set = new Set<number>(); dowTemplates.set(a.workerId, set); }
      set.add(s.dow);
    }
    hintsProvided = hints.length;
    templateWorkers = dowTemplates.size;
    for (const set of dowTemplates.values()) templateDowTotal += set.size;

    const warmWeights: WeightConfig = templateMatchWeight !== undefined
      ? { ...job.weights, templateMatch: templateMatchWeight }
      : job.weights;
    warm = await solveOnce(inputs, r.ilpConfig, warmWeights, hints, dowTemplates);
    warmMetrics = computeMetrics(inputs, warm.result);
  }

  const primary = warm ?? cold;
  const primaryMetrics = warmMetrics ?? coldMetrics;

  return {
    ts: new Date().toISOString(),
    weightIdx: job.weightIdx,
    weightName: job.weightName,
    weights: job.weights,
    restaurant: job.restaurant,
    scenario: job.scenario,
    status: primary.result.status,
    objectiveValue: primary.result.objectiveValue,
    solveTimeMs: Math.round(primary.result.solveTimeMs),
    stats: primary.result.stats,
    metrics: primaryMetrics,
    error: primary.error,
    assignmentCount: primary.result.assignments.length,
    assignments: primary.result.assignments.map((a: any) => [a.workerId, a.slotId] as [string, number]),
    // Warm-start telemetry — populated only when --warm-start is on.
    warmStart: warmStart ? {
      hintsProvided,
      templateMatchWeight: templateMatchWeight ?? null,
      templateWorkers,
      templateDowTotal,
      cold: {
        status: cold.result.status,
        objectiveValue: cold.result.objectiveValue,
        solveTimeMs: Math.round(cold.result.solveTimeMs),
        assignmentCount: cold.result.assignments.length,
        metrics: coldMetrics,
        error: cold.error,
        assignments: cold.result.assignments.map((a: any) => [a.workerId, a.slotId] as [string, number]),
      },
    } : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  setScenarioWeeks(args.weeks);
  const scenarios: ScenarioName[] = args.scenarios === "all" ? [...SCENARIOS] : args.scenarios;

  // Build restaurant configs.
  const restaurants = sampleAxes(args.axesSeed, args.restaurants);

  // Build weight grid.
  let weightConfigs: Array<{ name: string; weights: WeightConfig }> = [];
  if (args.weightsFile) {
    const raw = await Bun.file(args.weightsFile).json();
    weightConfigs = raw.map((w: WeightConfig, i: number) => ({ name: `custom_${i}`, weights: w }));
  } else if (args.grid === "single" || args.grid === "default") {
    weightConfigs = [{ name: "default", weights: DEFAULT_WEIGHTS }];
  } else if (args.grid === "fine") {
    if (!args.fineCenter) throw new Error("--grid fine requires --fine-center <path-to-json>");
    const center = await Bun.file(args.fineCenter).json() as WeightConfig;
    const grid = fineGrid(center, args.fineCount!);
    weightConfigs = grid.map((w, i) => ({ name: `fine_${i}`, weights: w }));
  } else if (args.grid === "cost") {
    const grid = costGrid();
    weightConfigs = grid.map((w, i) => ({ name: `cost_${i}`, weights: w }));
  } else if (args.grid === "presets") {
    weightConfigs = Object.entries(PRESETS).map(([name, w]) => ({ name, weights: w }));
  } else {
    const grid = coarseGrid();
    weightConfigs = grid.map((w, i) => ({ name: `coarse_${i}`, weights: w }));
  }

  // Optional slice of the built grid — keeps original names/indices so partial re-runs merge cleanly.
  if (args.weightsRange) {
    const [start, end] = args.weightsRange;
    weightConfigs = weightConfigs.slice(start, end);
  }

  // Optional single-preset filter (for targeted measurement runs).
  if (args.preset) {
    const before = weightConfigs.length;
    weightConfigs = weightConfigs.filter(wc => wc.name === args.preset);
    if (weightConfigs.length === 0) throw new Error(`--preset "${args.preset}" matched no weight configs (of ${before} built)`);
  }

  // Build job list.
  const jobs: Job[] = [];
  for (const wc of weightConfigs) {
    const wIdx = weightConfigs.indexOf(wc);
    for (const r of restaurants) {
      for (const s of scenarios) {
        jobs.push({ weightIdx: wIdx, weightName: wc.name, weights: wc.weights, restaurant: r, scenario: s });
      }
    }
  }
  if (args.limit) jobs.splice(args.limit);

  // Set the solver URL via env var (cpsat-solver.ts reads it once at module load).
  process.env.CPSAT_SOLVER_URL = args.solverUrl;
  process.env.CPSAT_TIMEOUT = String(args.timeout);

  // Prep output file.
  await mkdir(dirname(args.output), { recursive: true });
  if (!existsSync(args.output)) writeFileSync(args.output, "");

  console.log(`harness: ${jobs.length} jobs (${weightConfigs.length} weights × ${restaurants.length} restaurants × ${scenarios.length} scenarios, ${args.weeks}-week horizon)`);
  console.log(`solver:  ${args.solverUrl}  timeout=${args.timeout}s  concurrency=${args.concurrency}`);
  const modeBits = args.warmStart
    ? `warm-start (cold + AddHint${args.templateMatchWeight !== undefined ? ` + template-match w=${args.templateMatchWeight}` : ""}, metrics from warm pass)`
    : "cold only";
  console.log(`mode:    ${modeBits}`);
  console.log(`output:  ${args.output}\n`);

  // Concurrent execution with a sliding-window pool.
  const t0 = performance.now();
  let done = 0, failed = 0;
  const inflight = new Set<Promise<void>>();

  const launch = async (job: Job) => {
    const out = await runJob(job, args.warmStart, args.templateMatchWeight);
    if (out.status === "error" || out.status === "infeasible") failed++;
    await appendFile(args.output, JSON.stringify(out) + "\n");
    done++;
    if (done % 10 === 0 || done === jobs.length) {
      const elapsed = (performance.now() - t0) / 1000;
      const rate = done / elapsed;
      const eta = (jobs.length - done) / rate;
      console.log(`  [${done}/${jobs.length}] ${(rate).toFixed(2)} jobs/s · ${failed} fail · ETA ${(eta).toFixed(0)}s`);
    }
  };

  for (const job of jobs) {
    const p = launch(job).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= args.concurrency) await Promise.race(inflight);
  }
  await Promise.all(inflight);

  const elapsed = (performance.now() - t0) / 1000;
  console.log(`\ndone: ${done} jobs in ${elapsed.toFixed(1)}s (${(done / elapsed).toFixed(2)} jobs/s, ${failed} failures)`);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
