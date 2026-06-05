import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for Phase 2 (SOLVER_FIX_PLAN.md):
// CP-SAT must emit one role-breakdown soft constraint per (slot, subRole),
// not just for the first slot of each (date, zone, role) group.
//
// Intercepts the CP-SAT sidecar HTTP call via a fetch stub to capture the
// constraints the builder produces without needing a live solver.

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

function makeWorker(id: string, subRoles: string[] = []): ILPWorker {
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

function makeSlot(id: number, date: string, startTime: string, endTime: string, roleBreakdown: Record<string, number>): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone: "A",
    role: "kitchen" as any,
    startTime,
    endTime,
    hours: 4,
    target: 2,
    existingFill: 0,
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

beforeEach(() => {
  __resetCircuitState();
  capturedRequest = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver role-breakdown emission", () => {
  test("emits a soft constraint per slot when multiple services share (date, zone, role)", async () => {
    const workers = [
      makeWorker("w1", ["Chef"]),
      makeWorker("w2", ["Chef"]),
      makeWorker("w3", ["Chef"]),
      makeWorker("w4", ["Chef"]),
    ];
    // Two kitchen services on the same date/zone, each needing 1 Chef.
    const slots = [
      makeSlot(1, "2026-04-27", "11:00", "15:00", { Chef: 1 }),
      makeSlot(2, "2026-04-27", "18:00", "22:00", { Chef: 1 }),
    ];

    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);

    expect(capturedRequest).not.toBeNull();
    const roleConstraints = (capturedRequest.constraints as any[]).filter(
      c => c.type === "soft_linear" && typeof c.id === "string" && c.id.startsWith("role_")
    );
    expect(roleConstraints.length).toBe(2);

    const ids = roleConstraints.map(c => c.id).sort();
    expect(ids).toEqual(["role_1_Chef", "role_2_Chef"]);
  });

  test("preserves compound-slot dedup (paired slot with higher id is skipped)", async () => {
    const workers = [makeWorker("w1", ["Chef"]), makeWorker("w2", ["Chef"])];
    const a = makeSlot(10, "2026-04-28", "11:00", "15:00", { Chef: 1 });
    const b = makeSlot(11, "2026-04-28", "18:00", "22:00", { Chef: 1 });
    a.compound = true; a.compoundPairId = 11;
    b.compound = true; b.compoundPairId = 10;

    await solveCPSAT(workers, [a, b], makeConfig(), alwaysAvailable);

    const roleConstraints = (capturedRequest.constraints as any[]).filter(
      c => c.type === "soft_linear" && typeof c.id === "string" && c.id.startsWith("role_")
    );
    // Only the lower-id slot (10) gets the constraint.
    expect(roleConstraints.length).toBe(1);
    expect(roleConstraints[0].id).toBe("role_10_Chef");
  });
});
