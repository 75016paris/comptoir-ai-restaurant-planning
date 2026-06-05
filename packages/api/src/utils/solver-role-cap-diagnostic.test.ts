import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveILP } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for Phase 6 (SOLVER_FIX_PLAN.md):
// When a slot's roleBreakdown requirement exceeds its remaining capacity
// (target - existingFill), both solvers silently cap it. The caller must
// learn via `roleRequirementReductions` so the reduction isn't invisible.

const origFetch = globalThis.fetch;

function stubCpsatFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url.endsWith("/solve")) {
      const body = JSON.parse(init?.body ?? "{}");
      const values = Object.fromEntries(
        (body.variables as any[])
          .filter(v => v.type === "bool")
          .map(v => [v.name, 0])
      );
      return new Response(
        JSON.stringify({ status: "OPTIMAL", values, objective: 0, wallTimeMs: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeWorker(id: string, subRoles: string[] = ["Chef"]): ILPWorker {
  return {
    id,
    name: id,
    role: "kitchen" as any,
    priority: 1,
    overtimeWilling: false,
    contractHours: 35,
    subRoles,
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

function makeSlot(
  id: number,
  target: number,
  existingFill: number,
  roleBreakdown: Record<string, number>,
): ILPSlot {
  return {
    id,
    date: "2026-04-27",
    dow: 1,
    zone: "A",
    role: "kitchen" as any,
    startTime: "11:00",
    endTime: "15:00",
    hours: 4,
    target,
    existingFill,
    compound: false,
    roleBreakdown,
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

describe("CP-SAT role-requirement reductions diagnostic", () => {
  beforeEach(() => {
    __resetCircuitState();
    stubCpsatFetch();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("reports reduction when roleBreakdown exceeds slot capacity", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2"), makeWorker("w3")];
    const slot = makeSlot(42, 2, 0, { Chef: 3 });

    const result = await solveCPSAT(workers, [slot], makeConfig(), alwaysAvailable);

    expect(result.roleRequirementReductions).toBeDefined();
    expect(result.roleRequirementReductions!).toContainEqual({
      slotId: 42,
      subRole: "Chef",
      requested: 3,
      capped: 2,
      reason: "slot-capacity",
    });
  });

  test("does not report a reduction when roleBreakdown fits within capacity", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slot = makeSlot(43, 2, 0, { Chef: 2 });

    const result = await solveCPSAT(workers, [slot], makeConfig(), alwaysAvailable);

    expect(result.roleRequirementReductions ?? []).toEqual([]);
  });

  test("accounts for existingFill when computing capacity", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slot = makeSlot(44, 3, 2, { Chef: 3 });

    const result = await solveCPSAT(workers, [slot], makeConfig(), alwaysAvailable);

    expect(result.roleRequirementReductions!).toContainEqual({
      slotId: 44,
      subRole: "Chef",
      requested: 3,
      capped: 1,
      reason: "slot-capacity",
    });
  });
});

describe.skip("ILP role-requirement reductions diagnostic — legacy backend disabled", () => {
  test("reports reduction when roleBreakdown exceeds slot capacity", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2"), makeWorker("w3")];
    const slot = makeSlot(42, 2, 0, { Chef: 3 });

    const result = await solveILP(workers, [slot], makeConfig(), alwaysAvailable);

    expect(result.roleRequirementReductions).toBeDefined();
    expect(result.roleRequirementReductions!).toContainEqual({
      slotId: 42,
      subRole: "Chef",
      requested: 3,
      capped: 2,
      reason: "slot-capacity",
    });
  });

  test("does not report a reduction when roleBreakdown fits within capacity", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slot = makeSlot(43, 2, 0, { Chef: 2 });

    const result = await solveILP(workers, [slot], makeConfig(), alwaysAvailable);

    expect(result.roleRequirementReductions ?? []).toEqual([]);
  });
});
