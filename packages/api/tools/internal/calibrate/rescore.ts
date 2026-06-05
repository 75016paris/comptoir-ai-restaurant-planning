// Re-score an existing sweep JSONL using the current metrics.ts — useful when you add
// a new metric and want to recompute the composite without re-running CP-SAT.
// Requires the sweep to have been run with the "assignments" field present
// (harness.ts stores it as [workerId, slotId] tuples).
//
// Usage:
//   bun run packages/api/tools/internal/calibrate/rescore.ts sweep.jsonl > sweep-rescored.jsonl
//   bun run packages/api/tools/internal/calibrate/analyze.ts sweep-rescored.jsonl

import { readFileSync } from "node:fs";
import { generateRestaurant } from "./generate.js";
import { buildScenario, type ScenarioName } from "./scenarios.js";
import { computeMetrics } from "./metrics.js";
import type { ILPResult } from "../../../src/utils/ilp-solver.js";

async function main() {
  const path = process.argv[2];
  if (!path) { console.error("Usage: rescore.ts <jsonl>"); process.exit(1); }

  const lines = readFileSync(path, "utf8").trim().split("\n");
  const restCache = new Map<string, ReturnType<typeof generateRestaurant>>();
  const inputsCache = new Map<string, ReturnType<typeof buildScenario>>();

  let rescored = 0, skipped = 0;
  for (const l of lines) {
    const o = JSON.parse(l);
    if (!o.assignments || !Array.isArray(o.assignments)) {
      // Pre-assignment-storage sweeps can't be rescored — pass through unchanged.
      console.log(l);
      skipped++;
      continue;
    }
    if (!restCache.has(o.restaurant.id)) {
      restCache.set(o.restaurant.id, generateRestaurant(o.restaurant.seed, o.restaurant));
    }
    const r = restCache.get(o.restaurant.id)!;
    const ck = `${o.restaurant.id}_${o.scenario}`;
    if (!inputsCache.has(ck)) inputsCache.set(ck, buildScenario(r, o.scenario as ScenarioName));
    const inputs = inputsCache.get(ck)!;

    // Rebuild a minimal ILPResult for computeMetrics.
    const result: ILPResult = {
      status: o.status,
      assignments: o.assignments.map(([wid, sid]: [string, number]) => ({
        workerId: wid, workerName: wid, slotId: sid,
      })),
      objectiveValue: o.objectiveValue,
      solveTimeMs: o.solveTimeMs,
      stats: o.stats,
    };
    const metrics = computeMetrics(inputs, result);
    console.log(JSON.stringify({ ...o, metrics }));
    rescored++;
  }
  console.error(`rescored ${rescored}, skipped ${skipped} (no assignments stored)`);
}
main();
