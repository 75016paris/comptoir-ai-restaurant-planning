// Solver regression fixture generator + runner.
//
// Writes (or verifies) a frozen snapshot of metrics for a deterministic
// synthetic scenario solved with DEFAULT_WEIGHTS. Used by CI to flag drift
// when the solver, metrics, or DEFAULT_WEIGHTS change.
//
// Fixture path: packages/api/tools/internal/calibrate/regression-fixture.json
// Generate:  bun run packages/api/tools/internal/calibrate/regression.ts --write
// Verify:    bun run packages/api/tools/internal/calibrate/regression.ts

import { readFileSync, writeFileSync } from "node:fs";
import { solveCPSAT } from "../../../src/utils/cpsat-solver.js";
import { generateRestaurant } from "./generate.js";
import { buildScenario } from "./scenarios.js";
import { computeMetrics } from "./metrics.js";
import { DEFAULT_WEIGHTS } from "@comptoir/shared";

const FIXTURE_PATH = "packages/api/tools/internal/calibrate/regression-fixture.json";
const SEED = 20260421;
const SCENARIO = "clean" as const;

// Keep the shape minimal — not every metric. Focus on the signal axes that
// would move if the solver or weights drift: the composite score, hard
// correctness metrics, and sanity-check counts.
interface FixtureSnapshot {
  meta: {
    seed: number;
    scenario: string;
    weightsVersion: string;
    createdAt: string;
  };
  stats: {
    workers: number;
    slots: number;
    assignments: number;
  };
  metrics: {
    fillRate: number;
    chefCoverage: number;
    otFairness: number;
    contractAdherence: number;
    consistency: number;
    subroleAccuracy: number;
    preferenceMatch: number;
    resilienceRaw: number;
    composite: number;
    passes: boolean;
  };
}

// Tolerance bands (absolute). Composite scales 0-1; counts exact.
const TOLERANCES = {
  composite: 0.005,
  fillRate: 0.01,
  chefCoverage: 0.01,
  otFairness: 0.02,
  contractAdherence: 0.02,
  consistency: 0.02,
  subroleAccuracy: 0.01,
  preferenceMatch: 0.02,
  resilienceRaw: 0.5,
} as const;

async function runFixture(): Promise<FixtureSnapshot> {
  const r = generateRestaurant(SEED, {
    id: "regression",
    seed: SEED,
    teamSize: 15,
    contractMix: "cdi-cdd",
    roleSplit: "balanced",
    serviceComplexity: "midi-soir",
    otWillingness: "mixed",
    restrictionsDensity: "medium",
    subroleHierarchy: "two-tier",
    demandPressure: "tight",
  });
  const inputs = buildScenario(r, SCENARIO);
  const result = await solveCPSAT(
    inputs.workers, inputs.slots, r.ilpConfig, inputs.checker,
    inputs.multiWeek, undefined, DEFAULT_WEIGHTS,
  );
  const m = computeMetrics(inputs, result);
  return {
    meta: {
      seed: SEED,
      scenario: SCENARIO,
      weightsVersion: "v2-2026-04-21",
      createdAt: new Date().toISOString(),
    },
    stats: {
      workers: inputs.workers.length,
      slots: inputs.slots.length,
      assignments: result.assignments.length,
    },
    metrics: {
      fillRate: m.fillRate,
      chefCoverage: m.chefCoverage,
      otFairness: m.otFairness,
      contractAdherence: m.contractAdherence,
      consistency: m.consistency,
      subroleAccuracy: m.subroleAccuracy,
      preferenceMatch: m.preferenceMatch,
      resilienceRaw: m.resilienceRaw ?? 0,
      composite: m.composite,
      passes: m.passes,
    },
  };
}

function compare(expected: FixtureSnapshot, actual: FixtureSnapshot): string[] {
  const diffs: string[] = [];
  // Stats: exact match
  for (const k of ["workers", "slots", "assignments"] as const) {
    if (expected.stats[k] !== actual.stats[k]) {
      diffs.push(`stats.${k}: expected ${expected.stats[k]}, got ${actual.stats[k]}`);
    }
  }
  // Metrics: tolerance bands
  for (const [k, tol] of Object.entries(TOLERANCES) as [keyof typeof TOLERANCES, number][]) {
    const e = expected.metrics[k];
    const a = actual.metrics[k];
    if (Math.abs(e - a) > tol) {
      diffs.push(`metrics.${k}: expected ${e.toFixed(4)} ± ${tol}, got ${a.toFixed(4)}`);
    }
  }
  if (expected.metrics.passes !== actual.metrics.passes) {
    diffs.push(`metrics.passes: expected ${expected.metrics.passes}, got ${actual.metrics.passes}`);
  }
  return diffs;
}

async function main() {
  const write = process.argv.includes("--write");
  const actual = await runFixture();

  if (write) {
    writeFileSync(FIXTURE_PATH, JSON.stringify(actual, null, 2) + "\n");
    console.log(`Wrote regression fixture → ${FIXTURE_PATH}`);
    console.log(`  composite=${actual.metrics.composite.toFixed(3)} fill=${actual.metrics.fillRate.toFixed(3)} resRaw=${actual.metrics.resilienceRaw.toFixed(2)}`);
    return;
  }

  let expected: FixtureSnapshot;
  try {
    expected = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  } catch (e) {
    console.error(`Fixture missing at ${FIXTURE_PATH}. Run with --write to create.`);
    process.exit(1);
  }
  const diffs = compare(expected, actual);
  if (diffs.length === 0) {
    console.log(`✓ regression fixture matches (composite=${actual.metrics.composite.toFixed(3)})`);
    return;
  }
  console.error(`✗ regression fixture drift:`);
  for (const d of diffs) console.error(`  ${d}`);
  console.error(`\nIf this drift is intentional, re-run with --write to update the fixture and document the change in the internal decision notes.`);
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
