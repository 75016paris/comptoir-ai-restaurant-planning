import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for Phase 8 (SOLVER_FIX_PLAN.md):
// `status: "infeasible"` results must carry a `reason` so callers can
// distinguish "no workers given" from "no eligible pairs" from "model infeasible".

const origFetch = globalThis.fetch;

function stubCpsatFetch(status: "OPTIMAL" | "INFEASIBLE" = "OPTIMAL") {
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
        JSON.stringify({ status, values: status === "OPTIMAL" ? values : undefined, objective: 0, wallTimeMs: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeWorker(id: string, role: "kitchen" | "floor" = "kitchen"): ILPWorker {
  return {
    id,
    name: id,
    role,
    priority: 1,
    overtimeWilling: false,
    contractHours: 35,
    subRoles: ["Chef"],
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

function makeSlot(id: number, role: "kitchen" | "floor" = "kitchen"): ILPSlot {
  return {
    id,
    date: "2026-04-27",
    dow: 1,
    zone: "A",
    role,
    startTime: "11:00",
    endTime: "15:00",
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

describe("CP-SAT infeasibility reason codes", () => {
  beforeEach(() => {
    __resetCircuitState();
    stubCpsatFetch("OPTIMAL");
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("empty workers → reason 'no-workers'", async () => {
    const result = await solveCPSAT([], [makeSlot(1)], makeConfig(), alwaysAvailable);
    expect(result.status).toBe("infeasible");
    expect(result.reason).toBe("no-workers");
  });

  test("empty slots → reason 'no-slots'", async () => {
    const result = await solveCPSAT([makeWorker("w1")], [], makeConfig(), alwaysAvailable);
    expect(result.status).toBe("infeasible");
    expect(result.reason).toBe("no-slots");
  });

  test("no eligible (worker, slot) pairs → reason 'no-eligible-pairs'", async () => {
    // salle worker + kitchen slot → role mismatch, zero pairs after filter.
    const result = await solveCPSAT(
      [makeWorker("w1", "floor")],
      [makeSlot(1, "kitchen")],
      makeConfig(),
      alwaysAvailable,
    );
    expect(result.status).toBe("infeasible");
    expect(result.reason).toBe("no-eligible-pairs");
  });

  test("sidecar returns INFEASIBLE → reason 'model-infeasible'", async () => {
    stubCpsatFetch("INFEASIBLE");
    const result = await solveCPSAT(
      [makeWorker("w1")],
      [makeSlot(1)],
      makeConfig(),
      alwaysAvailable,
    );
    expect(result.status).toBe("infeasible");
    expect(result.reason).toBe("model-infeasible");
  });

  test("feasible solve → no reason field", async () => {
    const result = await solveCPSAT(
      [makeWorker("w1")],
      [makeSlot(1)],
      makeConfig(),
      alwaysAvailable,
    );
    // stub returns OPTIMAL with all vars=0 → status "optimal", no infeasibility reason.
    expect(result.status).toBe("optimal");
    expect(result.reason).toBeUndefined();
  });
});
