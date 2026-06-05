import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Audit C2 (P0): cache fingerprints fold CPSAT_RANDOM_SEED/CPSAT_NUM_WORKERS
// (services/hint-store.ts:38, services/baseline-cache.ts:71), so the fingerprint
// only stays honest if the request builder actually sends those values to the
// sidecar as options.randomSeed / options.numWorkers (cpsat-solver.ts:855-858,
// emitted via options: optionsExt at :883; sidecar reads them at
// cpsat_server.py:254-255). This test pins the wire-format emission — not the
// end-to-end deterministic-results behavior, which requires a live sidecar.

const origFetch = globalThis.fetch;
const origSeed = process.env.CPSAT_RANDOM_SEED;
const origWorkers = process.env.CPSAT_NUM_WORKERS;
const origTimeout = process.env.CPSAT_TIMEOUT;

let capturedOptions: Record<string, unknown> | undefined;

function stubFetch() {
  capturedOptions = undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url.endsWith("/solve")) {
      const request = JSON.parse(init?.body ?? "{}");
      capturedOptions = request.options;
      const values = Object.fromEntries(
        (request.variables as any[])
          .filter(v => v.type === "bool")
          .map(v => [v.name, 0]),
      );
      return new Response(
        JSON.stringify({ status: "OPTIMAL", values, wallTimeMs: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeWorker(id: string): ILPWorker {
  return {
    id,
    name: id,
    role: "floor" as any,
    priority: 1,
    overtimeWilling: false,
    contractHours: 35,
    subRoles: [],
    existingWeeklyHours: 0,
    existingWorkDates: new Set(),
    existingDailyHours: new Map(),
    existingLastEnd: new Map(),
    existingFirstStart: new Map(),
    existingServicesByDate: new Map(),
    historicalHours: 0,
    historicalWeeks: 4,
    consistency: new Map(),
    flexibility: 1,
  };
}

function makeSlot(id: number, date: string, startTime: string, endTime: string): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone: "floor",
    role: "floor" as any,
    startTime,
    endTime,
    hours: 4,
    target: 1,
    existingFill: 0,
    compound: false,
  };
}

function makeConfig(): ILPConfig {
  return {
    maxDailyHoursCompound: 11,
    minRestHours: 11,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 5,
    max12WeekAvgHours: 46,
    otCap: 43,
    disabledRules: new Set(),
    otDistribution: "equal",
    dayPriorityMap: {},
    prefEnabled: false,
    templates: [],
  };
}

const alwaysAvailable: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

async function runOnce(): Promise<void> {
  await solveCPSAT(
    [makeWorker("w1")],
    [makeSlot(1, "2026-04-27", "11:00", "15:00")],
    makeConfig(),
    alwaysAvailable,
  );
}

async function runLargeOnce(): Promise<void> {
  await solveCPSAT(
    Array.from({ length: 80 }, (_, i) => makeWorker(`w${i + 1}`)),
    Array.from({ length: 120 }, (_, i) => makeSlot(i + 1, "2026-04-27", "11:00", "15:00")),
    makeConfig(),
    alwaysAvailable,
  );
}

beforeEach(() => {
  __resetCircuitState();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origSeed === undefined) delete process.env.CPSAT_RANDOM_SEED;
  else process.env.CPSAT_RANDOM_SEED = origSeed;
  if (origWorkers === undefined) delete process.env.CPSAT_NUM_WORKERS;
  else process.env.CPSAT_NUM_WORKERS = origWorkers;
  if (origTimeout === undefined) delete process.env.CPSAT_TIMEOUT;
  else process.env.CPSAT_TIMEOUT = origTimeout;
});

describe("cpsat-solver forwards determinism env vars into request.options", () => {
  test("CPSAT_RANDOM_SEED=42 emits options.randomSeed=42", async () => {
    process.env.CPSAT_RANDOM_SEED = "42";
    await runOnce();
    expect(capturedOptions?.randomSeed).toBe(42);
  });

  test("CPSAT_RANDOM_SEED=7 emits options.randomSeed=7", async () => {
    process.env.CPSAT_RANDOM_SEED = "7";
    await runOnce();
    expect(capturedOptions?.randomSeed).toBe(7);
  });

  test("CPSAT_NUM_WORKERS=4 emits options.numWorkers=4", async () => {
    process.env.CPSAT_NUM_WORKERS = "4";
    await runOnce();
    expect(capturedOptions?.numWorkers).toBe(4);
  });

  test("CPSAT_NUM_WORKERS=1 emits options.numWorkers=1", async () => {
    process.env.CPSAT_NUM_WORKERS = "1";
    await runOnce();
    expect(capturedOptions?.numWorkers).toBe(1);
  });

  test("unset CPSAT_RANDOM_SEED omits options.randomSeed (sidecar falls back to DEFAULT_RANDOM_SEED)", async () => {
    delete process.env.CPSAT_RANDOM_SEED;
    await runOnce();
    expect(capturedOptions).toBeDefined();
    expect("randomSeed" in (capturedOptions as object)).toBe(false);
  });

  test("non-positive CPSAT_NUM_WORKERS=0 omits options.numWorkers (sidecar falls back to DEFAULT_NUM_WORKERS)", async () => {
    process.env.CPSAT_NUM_WORKERS = "0";
    await runOnce();
    expect(capturedOptions).toBeDefined();
    expect("numWorkers" in (capturedOptions as object)).toBe(false);
  });

  // Audit H4 (P1): reproducibility requires the sidecar to set
  // `solver.parameters.max_deterministic_time` (cpsat_server.py:246) instead of
  // wall-clock `max_time_in_seconds`. The sidecar derives the deterministic
  // budget from `options.timeLimitSeconds * WALL_TO_DET_RATIO`
  // (cpsat_server.py:244), so the wire-format contract is that the TS client
  // emits `options.timeLimitSeconds` in wall-seconds. These cases pin that
  // emission — the Python-side wall→det conversion is covered by the sidecar's
  // own tests and is not duplicated here.
  test("CPSAT_TIMEOUT=20 emits options.timeLimitSeconds=20", async () => {
    process.env.CPSAT_TIMEOUT = "20";
    await runOnce();
    expect(capturedOptions?.timeLimitSeconds).toBe(20);
  });

  test("unset CPSAT_TIMEOUT emits dynamic options.timeLimitSeconds", async () => {
    delete process.env.CPSAT_TIMEOUT;
    await runOnce();
    expect(capturedOptions?.timeLimitSeconds).toBe(3);
  });

  test("larger models keep the longer dynamic timeout", async () => {
    delete process.env.CPSAT_TIMEOUT;
    await runLargeOnce();
    expect(capturedOptions?.timeLimitSeconds).toBe(12);
  });

  test("unset CPSAT_NUM_WORKERS emits dynamic options.numWorkers", async () => {
    delete process.env.CPSAT_NUM_WORKERS;
    await runOnce();
    expect(capturedOptions?.numWorkers).toBe(1);
  });
});
