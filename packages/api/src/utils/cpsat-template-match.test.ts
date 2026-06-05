import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { DEFAULT_WEIGHTS, type WeightConfig } from "@comptoir/shared";
import { __resetCircuitState } from "./solver-circuit.js";

// Step 2 (équipe-stable next-steps): when weights.templateMatch > 0 and a
// per-worker dow template is supplied, the per-(worker, slot) objective
// coefficient picks up an additional +templateMatch × SCALE bump on vars
// whose slot.dow is in the worker's template. Mirrors the shape of
// cpsat-slot-floor.test.ts (fetch stub captures the dabke request and we
// assert on objective.terms).

const SCALE = 60; // must match cpsat-solver.ts

const origFetch = globalThis.fetch;
let capturedRequest: any = null;

function stubFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url.endsWith("/solve")) {
      capturedRequest = JSON.parse(init?.body ?? "{}");
      const values = Object.fromEntries(
        (capturedRequest.variables as any[])
          .filter(v => v.type === "bool")
          .map(v => [v.name, 0]),
      );
      return new Response(
        JSON.stringify({ status: "OPTIMAL", values, objective: 0, wallTimeMs: 0 }),
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
    flexibility: 0, // disable the flexibility bonus so the two workers' vars start equal
  };
}

function makeSlot(id: number, date: string): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone: "floor",
    role: "floor" as any,
    startTime: "11:00",
    endTime: "15:00",
    hours: 4,
    target: 2,
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

// All per-assignment soft terms except fill disabled, so the coefficient delta
// between the two workers isolates the templateMatch contribution.
function minimalWeights(over: Partial<WeightConfig> = {}): WeightConfig {
  return {
    ...DEFAULT_WEIGHTS,
    fill: 1000,
    consistency: 0,
    preference: 0,
    priority: 0,
    flexibility: 0,
    subroleMismatch: 0,
    rolePenalty: 0,
    costAwareness: 0,
    leaveConservation: 0,
    redundancy: 0,
    templateMatch: 0,
    ...over,
  };
}

function findAssignmentVarByWorker(req: any, workerId: string, slotIdx: number): { name: string; coeff: number } {
  // Find the request's assignment var for this worker-slot pair via the
  // slot-capacity constraint (C1): one linear <= constraint per slot whose
  // `terms` are exactly the per-slot x_ vars. We only have one slot, so
  // every bool x_* participates — pick by var suffix order by construction
  // (vars are created in worker-outer, slot-inner order in cpsat-solver.ts).
  const bools = (req.variables as any[]).filter(v => v.type === "bool" && v.name.startsWith("x_"));
  // cpsat-solver iterates workers in outer, slots in inner. With 1 slot and
  // 2 workers, bools[0] is w1's var, bools[1] is w2's. (We pass workers in
  // a fixed order, and role/availability filters pass both.)
  const name = bools[slotIdx].name;
  const term = (req.objective.terms as any[]).find(t => t.var === name);
  if (!term) throw new Error(`no objective term for ${name}`);
  return term;
}

beforeEach(() => {
  __resetCircuitState();
  capturedRequest = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver template-match objective term", () => {
  test("weight > 0 + template contains slot.dow → var coeff gains templateMatch × SCALE", async () => {
    const w1 = makeWorker("w1"); // in template for this dow
    const w2 = makeWorker("w2"); // not in template
    const slots = [makeSlot(1, "2026-04-28")]; // dow = 2 (Tuesday UTC)
    const templates = new Map<string, Set<number>>([
      ["w1", new Set<number>([2])],
      ["w2", new Set<number>()],
    ]);
    const weights = minimalWeights({ templateMatch: 80 });

    await solveCPSAT(
      [w1, w2], slots, makeConfig(), alwaysAvailable,
      undefined, undefined, weights, undefined, templates,
    );

    expect(capturedRequest).not.toBeNull();
    const tW1 = findAssignmentVarByWorker(capturedRequest, "w1", 0);
    const tW2 = findAssignmentVarByWorker(capturedRequest, "w2", 1);

    // w1 gets fill + templateMatch, w2 gets fill only. Delta = 80 × 60 = 4800.
    expect(tW2.coeff).toBe(Math.round(1000 * SCALE));
    expect(tW1.coeff).toBe(Math.round((1000 + 80) * SCALE));
    expect(tW1.coeff - tW2.coeff).toBe(80 * SCALE);
  });

  test("weight > 0 but no templates map supplied → no extra coefficient", async () => {
    const w1 = makeWorker("w1");
    const slots = [makeSlot(1, "2026-04-28")];
    const weights = minimalWeights({ templateMatch: 80 });

    await solveCPSAT(
      [w1], slots, makeConfig(), alwaysAvailable,
      undefined, undefined, weights, undefined, undefined, // no templates
    );

    const t = findAssignmentVarByWorker(capturedRequest, "w1", 0);
    expect(t.coeff).toBe(Math.round(1000 * SCALE));
  });

  test("weight = 0 + template present → no extra coefficient", async () => {
    const w1 = makeWorker("w1");
    const slots = [makeSlot(1, "2026-04-28")];
    const templates = new Map<string, Set<number>>([["w1", new Set<number>([2])]]);
    const weights = minimalWeights({ templateMatch: 0 });

    await solveCPSAT(
      [w1], slots, makeConfig(), alwaysAvailable,
      undefined, undefined, weights, undefined, templates,
    );

    const t = findAssignmentVarByWorker(capturedRequest, "w1", 0);
    expect(t.coeff).toBe(Math.round(1000 * SCALE));
  });

  test("template does not contain slot.dow → no extra coefficient for that var", async () => {
    const w1 = makeWorker("w1");
    const slots = [makeSlot(1, "2026-04-28")]; // dow=2
    const templates = new Map<string, Set<number>>([["w1", new Set<number>([3, 4])]]); // Wed/Thu only
    const weights = minimalWeights({ templateMatch: 80 });

    await solveCPSAT(
      [w1], slots, makeConfig(), alwaysAvailable,
      undefined, undefined, weights, undefined, templates,
    );

    const t = findAssignmentVarByWorker(capturedRequest, "w1", 0);
    expect(t.coeff).toBe(Math.round(1000 * SCALE));
  });
});
