// Print a schedule for a specific (config, restaurant, scenario) triple in readable form.
// Uses the restaurant config stored in the JSONL to re-generate workers/slots/inputs locally,
// then re-solves once with the stored weights and prints the assignments as a week grid.
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/inspect.ts \
//     --weights-from sweep.jsonl --weight-name coarse_23 \
//     --restaurant r42n5 --scenario clean
//
//   bun run packages/api/tools/internal/calibrate/inspect.ts \
//     --weights-json '{"fill":1000,...}' \
//     --restaurant r42n5 --scenario clean

import { readFileSync } from "node:fs";
import { generateRestaurant, type RestaurantConfig } from "./generate.js";
import { buildScenario, type ScenarioName, SCENARIOS } from "./scenarios.js";
import { solveCPSAT } from "../../../src/utils/cpsat-solver.js";
import { DEFAULT_WEIGHTS, type WeightConfig, hasChefLabel, hasSousChefLabel } from "@comptoir/shared";

function getArg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const sweepPath = getArg("--weights-from");
  const weightName = getArg("--weight-name");
  const weightsJson = getArg("--weights-json");
  const restId = getArg("--restaurant");
  const scenarioArg = getArg("--scenario", "clean");
  const solverUrl = getArg("--solver-url", process.env.CPSAT_SOLVER_URL || "http://localhost:8090")!;
  const timeout = Number(getArg("--timeout", "12"));

  if (!restId) throw new Error("--restaurant required (e.g., r42n5)");
  if (!SCENARIOS.includes(scenarioArg as ScenarioName)) throw new Error(`unknown scenario ${scenarioArg}`);

  // Locate the restaurant config + weights.
  let restaurant: RestaurantConfig | null = null;
  let weights: WeightConfig = DEFAULT_WEIGHTS;

  if (sweepPath) {
    const lines = readFileSync(sweepPath, "utf8").trim().split("\n");
    for (const l of lines) {
      const o = JSON.parse(l);
      if (o.restaurant.id === restId) restaurant = o.restaurant;
      if (weightName && o.weightName === weightName) weights = o.weights;
    }
  }
  if (weightsJson) weights = JSON.parse(weightsJson);

  if (!restaurant) {
    throw new Error(`restaurant ${restId} not found in ${sweepPath ?? "(no sweep)"} — pass --sweep <path>`);
  }

  process.env.CPSAT_SOLVER_URL = solverUrl;
  process.env.CPSAT_TIMEOUT = String(timeout);

  const r = generateRestaurant(restaurant.seed, restaurant);
  const inputs = buildScenario(r, scenarioArg as ScenarioName);
  console.log(`Restaurant ${restId} — size=${restaurant.teamSize} hier=${restaurant.subroleHierarchy} complexity=${restaurant.serviceComplexity} pressure=${restaurant.demandPressure}`);
  console.log(`Scenario:  ${scenarioArg}  |  workers=${inputs.workers.length}  slots=${inputs.slots.length}  weeks=${inputs.multiWeek?.numWeeks ?? 1}`);
  console.log(`Weights:   ${weightName ?? "default"}`);
  console.log();

  const result = await solveCPSAT(
    inputs.workers, inputs.slots, r.ilpConfig, inputs.checker,
    inputs.multiWeek, undefined, weights,
  );
  console.log(`Status: ${result.status}  obj=${result.objectiveValue?.toFixed(0) ?? "?"}  time=${result.solveTimeMs.toFixed(0)}ms  vars=${result.stats.variables}  constr=${result.stats.constraints}`);
  console.log();

  // Print schedule grid: rows = workers, cols = (week, dow, zone)
  const slotsById = new Map(inputs.slots.map(s => [s.id, s]));
  const byWorker = new Map<string, number[]>();
  for (const a of result.assignments) {
    if (!byWorker.has(a.workerId)) byWorker.set(a.workerId, []);
    byWorker.get(a.workerId)!.push(a.slotId);
  }

  // Build list of unique (week, dow, zone) column keys.
  const cols = new Set<string>();
  for (const s of inputs.slots) cols.add(`${s.week ?? 0}|${s.dow}|${s.zone}`);
  const colList = [...cols].sort();

  // Header
  const rolePrefix = (r: string) => r === "kitchen" ? "K" : "S";
  console.log(" ".repeat(22) + colList.map(k => {
    const [wk, dow, zone] = k.split("|");
    return `w${wk}.d${dow}.${zone.slice(0, 3)}`;
  }).join("  "));

  // Rows — one per worker
  for (const w of inputs.workers.sort((a, b) => a.role.localeCompare(b.role) || a.priority - b.priority)) {
    const assigned = byWorker.get(w.id) ?? [];
    const totalHours = assigned.reduce((s, sid) => s + (slotsById.get(sid)?.hours ?? 0), 0);
    const cells = colList.map(k => {
      const [wk, dow, zone] = k.split("|");
      const slot = inputs.slots.find(s => String(s.week ?? 0) === wk && String(s.dow) === dow && s.zone === zone);
      if (!slot || !assigned.includes(slot.id)) return "         ·";
      const hrs = slot.hours.toFixed(1);
      return `       ${hrs.padStart(4)}`;
    });
    const tag = hasChefLabel(w.subRoles) ? "CHEF" : hasSousChefLabel(w.subRoles) ? "SC  " : "    ";
    const label = `${rolePrefix(w.role)}${String(w.priority).padStart(2)} ${tag} ${w.contractHours}h`;
    console.log(`${label.padEnd(20)} ${totalHours.toFixed(0).padStart(3)}h  ${cells.join("  ")}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
