import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for the P3 audit fix (M11): the sidecar now emits
// `objectiveValue` at the top level of the solver response on
// OPTIMAL/FEASIBLE, and the client surfaces it as ILPResult.objectiveValue
// instead of hardcoding undefined.

const origFetch = globalThis.fetch;

function stubFetch(body: Record<string, unknown>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url.endsWith("/solve")) {
      const request = JSON.parse(init?.body ?? "{}");
      const values = Object.fromEntries(
        (request.variables as any[])
          .filter(v => v.type === "bool")
          .map(v => [v.name, 0]),
      );
      return new Response(
        JSON.stringify({ status: "OPTIMAL", values, ...body }),
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

beforeEach(() => {
  __resetCircuitState();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver surfaces objectiveValue on feasible solves", () => {
  test("reads top-level objectiveValue from sidecar response", async () => {
    stubFetch({ objectiveValue: 12345.5, wallTimeMs: 0 });

    const res = await solveCPSAT(
      [makeWorker("w1")],
      [makeSlot(1, "2026-04-27", "11:00", "15:00")],
      makeConfig(),
      alwaysAvailable,
    );

    expect(typeof res.objectiveValue).toBe("number");
    expect(res.objectiveValue).toBe(12345.5);
  });

  test("objectiveValue is undefined when sidecar omits it", async () => {
    stubFetch({ wallTimeMs: 0 });

    const res = await solveCPSAT(
      [makeWorker("w1")],
      [makeSlot(1, "2026-04-27", "11:00", "15:00")],
      makeConfig(),
      alwaysAvailable,
    );

    expect(res.objectiveValue).toBeUndefined();
  });
});
