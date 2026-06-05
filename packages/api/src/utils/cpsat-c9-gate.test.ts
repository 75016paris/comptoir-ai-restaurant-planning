import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker, MultiWeekConfig } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for Phase 4 (SOLVER_FIX_PLAN.md):
// The C9 freshness gate is the single source of truth for whether a rolling-
// average cap applies. The builder must not secondarily re-gate on the raw
// `historicalWeeks` threshold; doing so silently disables the constraint for
// low-confidence workers that the gate already decided to apply (with a
// widened cap). Multi-week arrays that don't match `numWeeks` should throw,
// not silently default to zero.

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

function makeWorker(id: string, over: Partial<ILPWorker> = {}): ILPWorker {
  return {
    id,
    name: id,
    role: "kitchen" as any,
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
    historicalWeeks: 8,
    consistency: new Map(),
    flexibility: 1,
    ...over,
  };
}

function makeSlot(id: number, date: string, week?: number): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone: "A",
    role: "kitchen" as any,
    startTime: "11:00",
    endTime: "15:00",
    hours: 4,
    target: 1,
    existingFill: 0,
    compound: false,
    ...(week !== undefined ? { week } : {}),
  };
}

function makeConfig(): ILPConfig {
  return {
    maxDailyHoursCompound: 11,
    minRestHours: 11,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 6,
    max12WeekAvgHours: 46,
    otCap: 48,
    disabledRules: new Set<string>(),
    otDistribution: "even" as any,
    dayPriorityMap: {},
    prefEnabled: false,
    templates: [],
  };
}

const alwaysAvailable: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

// Identify C9 hour-cap constraints. Both C5 (weekly cap) and C9 (12-week
// rolling) emit `linear <=` constraints with coeff = slot.hours*SCALE on
// worker x_ vars. Disambiguate by RHS magnitude: C5's rhs is bounded by
// otCap*SCALE (~48*60 = 2880 minutes); C9's rhs is bounded by
// max12WeekAvgHours*12*SCALE (~46*12*60 = 33120 minutes). A threshold of
// 5000 minutes cleanly separates them for the test fixtures below.
function c9HourCapConstraints(req: any): Array<{ termCount: number; rhs: number }> {
  return (req.constraints as any[])
    .filter(c => c.type === "linear" && c.op === "<=" && Array.isArray(c.terms))
    .filter(c => c.terms.length > 0 && c.terms.every((t: any) => typeof t.var === "string" && t.var.startsWith("x_") && t.coeff > 1))
    .filter(c => c.rhs > 5000)
    .map(c => ({ termCount: c.terms.length, rhs: c.rhs }));
}

beforeEach(() => {
  __resetCircuitState();
  capturedRequest = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver C9 freshness gate single source of truth", () => {
  test("single-week: low-confidence worker (historicalWeeks=4) gets C9 cap emitted", async () => {
    // historicalWeeks=4 → "low" confidence → gate decides apply=true, widened.
    // Pre-fix: builder re-gates on `w.historicalWeeks < 6` and skips constraint.
    // Post-fix: gate decision is authoritative → C9 cap emitted.
    const worker = makeWorker("w1", { historicalWeeks: 4, historicalHours: 100 });
    const slots = [makeSlot(1, "2026-04-20")];

    await solveCPSAT([worker], slots, makeConfig(), alwaysAvailable);

    expect(capturedRequest).not.toBeNull();
    const caps = c9HourCapConstraints(capturedRequest);
    // With 1 slot and decision.apply=true, we expect exactly one C9 hour-cap
    // constraint summing the worker's single x_ var.
    expect(caps.length).toBeGreaterThanOrEqual(1);
  });

  test("multi-week: low-confidence worker gets C9 cap in every week (not just wk>=6-historical)", async () => {
    // historicalWeeks=4. Pre-fix multi-week re-gate: skip weeks where
    // historicalWeeks+wk < 6 → skips wk=0 and wk=1. Post-fix: gate decides
    // once → constraint emitted for all 3 weeks.
    const worker = makeWorker("w1", { historicalWeeks: 4, historicalHours: 100 });
    const numWeeks = 3;
    const slots = [
      makeSlot(1, "2026-04-20", 0),
      makeSlot(2, "2026-04-27", 1),
      makeSlot(3, "2026-05-04", 2),
    ];
    const multiWeek: MultiWeekConfig = {
      numWeeks,
      existingHoursByWeek: new Map([["w1", [0, 0, 0]]]),
      c9BaseHours: new Map([["w1", [100, 100, 100]]]),
      c9BaseWeeks: new Map([["w1", [4, 4, 4]]]),
    };

    await solveCPSAT([worker], slots, makeConfig(), alwaysAvailable, multiWeek);

    expect(capturedRequest).not.toBeNull();
    const caps = c9HourCapConstraints(capturedRequest);
    // One C9 window constraint per week (each window sums the slot(s) in that
    // week plus any prior-week slots in the 12-week trailing window).
    expect(caps.length).toBe(numWeeks);
  });

  test("multi-week: high-confidence worker (historicalWeeks=8) still gets C9 in all weeks", async () => {
    // Positive regression: high confidence path continues to emit per week.
    const worker = makeWorker("w1", { historicalWeeks: 8, historicalHours: 200 });
    const numWeeks = 4;
    const slots = [
      makeSlot(1, "2026-04-20", 0),
      makeSlot(2, "2026-04-27", 1),
      makeSlot(3, "2026-05-04", 2),
      makeSlot(4, "2026-05-11", 3),
    ];
    const multiWeek: MultiWeekConfig = {
      numWeeks,
      existingHoursByWeek: new Map([["w1", [0, 0, 0, 0]]]),
      c9BaseHours: new Map([["w1", [200, 200, 200, 200]]]),
      c9BaseWeeks: new Map([["w1", [8, 8, 8, 8]]]),
    };

    await solveCPSAT([worker], slots, makeConfig(), alwaysAvailable, multiWeek);

    const caps = c9HourCapConstraints(capturedRequest);
    expect(caps.length).toBe(numWeeks);
  });

  test("multi-week: no-history worker (historicalWeeks=0) → gate says skip, no C9 emitted", async () => {
    // confidence=none → decision.apply=false → no C9 constraint in any week.
    const worker = makeWorker("w1", { historicalWeeks: 0, historicalHours: 0 });
    const numWeeks = 3;
    const slots = [
      makeSlot(1, "2026-04-20", 0),
      makeSlot(2, "2026-04-27", 1),
      makeSlot(3, "2026-05-04", 2),
    ];
    const multiWeek: MultiWeekConfig = {
      numWeeks,
      existingHoursByWeek: new Map([["w1", [0, 0, 0]]]),
      c9BaseHours: new Map([["w1", [0, 0, 0]]]),
      c9BaseWeeks: new Map([["w1", [0, 0, 0]]]),
    };

    await solveCPSAT([worker], slots, makeConfig(), alwaysAvailable, multiWeek);

    const caps = c9HourCapConstraints(capturedRequest);
    expect(caps.length).toBe(0);
  });

  test("multi-week: c9BaseWeeks length mismatch throws loudly", async () => {
    const worker = makeWorker("w1", { historicalWeeks: 8 });
    const slots = [makeSlot(1, "2026-04-20", 0), makeSlot(2, "2026-04-27", 1)];
    const bad: MultiWeekConfig = {
      numWeeks: 2,
      existingHoursByWeek: new Map([["w1", [0, 0]]]),
      c9BaseHours: new Map([["w1", [0, 0]]]),
      c9BaseWeeks: new Map([["w1", [8]]]), // length 1, expected 2
    };

    await expect(solveCPSAT([worker], slots, makeConfig(), alwaysAvailable, bad)).rejects.toThrow(/c9BaseWeeks/);
  });

  test("multi-week: c9BaseHours length mismatch throws loudly", async () => {
    const worker = makeWorker("w1", { historicalWeeks: 8 });
    const slots = [makeSlot(1, "2026-04-20", 0), makeSlot(2, "2026-04-27", 1)];
    const bad: MultiWeekConfig = {
      numWeeks: 2,
      existingHoursByWeek: new Map([["w1", [0, 0]]]),
      c9BaseHours: new Map([["w1", [0, 0, 0]]]), // length 3, expected 2
      c9BaseWeeks: new Map([["w1", [8, 8]]]),
    };

    await expect(solveCPSAT([worker], slots, makeConfig(), alwaysAvailable, bad)).rejects.toThrow(/c9BaseHours/);
  });

  test("multi-week: existingHoursByWeek length mismatch throws loudly", async () => {
    const worker = makeWorker("w1", { historicalWeeks: 8 });
    const slots = [makeSlot(1, "2026-04-20", 0), makeSlot(2, "2026-04-27", 1)];
    const bad: MultiWeekConfig = {
      numWeeks: 2,
      existingHoursByWeek: new Map([["w1", []]]), // length 0, expected 2
      c9BaseHours: new Map([["w1", [0, 0]]]),
      c9BaseWeeks: new Map([["w1", [8, 8]]]),
    };

    await expect(solveCPSAT([worker], slots, makeConfig(), alwaysAvailable, bad)).rejects.toThrow(/existingHoursByWeek/);
  });
});
