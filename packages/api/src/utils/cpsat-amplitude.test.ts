import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

const origFetch = globalThis.fetch;

type CapturedRequest = {
  variables: Array<{ type: string; name: string }>;
  constraints: Array<Record<string, unknown>>;
};
let captured: CapturedRequest | undefined;

function stubFetch() {
  captured = undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url.endsWith("/solve")) {
      const request = JSON.parse(init?.body ?? "{}");
      captured = { variables: request.variables, constraints: request.constraints };
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

function makeWorker(id: string, over: Partial<ILPWorker> = {}): ILPWorker {
  return {
    id,
    name: id,
    role: "floor" as any,
    priority: 1,
    overtimeWilling: true,
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
    ...over,
  };
}

function makeSlot(id: number, startTime: string, endTime: string, over: Partial<ILPSlot> = {}): ILPSlot {
  return {
    id,
    date: "2026-06-02",
    dow: 2,
    zone: id === 1 ? "MIDI" : "SOIR",
    role: "floor" as any,
    startTime,
    endTime,
    hours: 5.5,
    target: 1,
    existingFill: 0,
    compound: false,
    ...over,
  };
}

function makeConfig(disabledRules = new Set<string>()): ILPConfig {
  return {
    maxDailyHoursCompound: 12,
    minRestHours: 10,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 5,
    max12WeekAvgHours: 46,
    otCap: 48,
    disabledRules,
    otDistribution: "even",
    dayPriorityMap: {},
    prefEnabled: false,
    templates: [],
  };
}

const alwaysAvailable: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

function assignmentVarNames(): string[] {
  return captured?.variables.filter(v => v.type === "bool" && v.name.startsWith("x_")).map(v => v.name) ?? [];
}

function hasAtMostOne(varA: string, varB: string): boolean {
  return (captured?.constraints ?? []).some(c =>
    c.type === "at_most_one"
    && (c.vars as string[]).includes(varA)
    && (c.vars as string[]).includes(varB),
  );
}

function hasZeroConstraint(varName: string): boolean {
  return (captured?.constraints ?? []).some(c =>
    c.type === "linear"
    && c.op === "=="
    && c.rhs === 0
    && Array.isArray(c.terms)
    && c.terms.length === 1
    && (c.terms[0] as any).var === varName
    && (c.terms[0] as any).coeff === 1,
  );
}

beforeEach(() => {
  __resetCircuitState();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver HCR-L3121-34 max amplitude", () => {
  test("blocks Chez Reno-style MIDI+SOIR assignment when same-day amplitude exceeds 13h", async () => {
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "10:00", "15:30"),
      makeSlot(2, "18:00", "23:30"),
    ];

    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);

    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasAtMostOne(names[0], names[1])).toBe(true);
  });

  test("allows Grand Brasserie-style coupure when same-day amplitude is exactly 13h", async () => {
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "09:30", "15:15", { compound: true, compoundPairId: 2, zone: "Coupure" }),
      makeSlot(2, "16:45", "22:30", { compound: true, compoundPairId: 1, zone: "Coupure" }),
    ];

    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);

    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasAtMostOne(names[0], names[1])).toBe(false);
  });

  test("blocks a candidate slot when existing same-day services would push amplitude over 13h", async () => {
    const workers = [makeWorker("w1", {
      existingServicesByDate: new Map([["2026-06-02", [{ startTime: "09:00", endTime: "12:00" }]]]),
      existingDailyHours: new Map([["2026-06-02", 3]]),
    })];
    const slots = [makeSlot(1, "21:30", "23:30", { hours: 2 })];

    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);

    const names = assignmentVarNames();
    expect(names.length).toBe(1);
    expect(hasZeroConstraint(names[0])).toBe(true);
  });

  test("does not emit amplitude constraints when HCR-L3121-34 is disabled", async () => {
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "10:00", "15:30"),
      makeSlot(2, "18:00", "23:30"),
    ];

    await solveCPSAT(workers, slots, makeConfig(new Set(["HCR-L3121-34"])), alwaysAvailable);

    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasAtMostOne(names[0], names[1])).toBe(false);
  });
});
