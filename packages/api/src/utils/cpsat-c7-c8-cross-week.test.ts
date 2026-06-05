import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker, MultiWeekConfig } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for Phase 3 (SOLVER_FIX_PLAN.md):
// C7 (max 6 consecutive days) and C8 (max 5 work days / 7-day window) must
// span week boundaries in multi-week solves. Indicator vars are built from
// `varsByWorker` (the per-worker union across weeks), so a 7-day consecutive
// window that crosses wk0→wk1 should still be bound.
//
// The audit flagged "indicators built per-week" as a risk; this test pins the
// current correct behavior so any future refactor that re-introduces per-week
// scoping will fail here.
//
// Stub-fetch approach (same as cpsat-role-breakdown.test.ts): we capture the
// CP-SAT request and assert the emitted constraint set — no live sidecar.

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

function makeWorker(id: string): ILPWorker {
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
    historicalWeeks: 4,
    consistency: new Map(),
    flexibility: 1,
  };
}

function makeSlot(id: number, date: string, week: number): ILPSlot {
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
    week,
  };
}

function makeConfig(): ILPConfig {
  return {
    maxDailyHoursCompound: 11,
    minRestHours: 11,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 5,
    max12WeekAvgHours: 46,
    otCap: 48,
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

// Helper: linear constraints whose terms are all y_* indicators with coeff=1.
function indicatorWindowConstraints(req: any): Array<{ termCount: number; rhs: number; op: string }> {
  return (req.constraints as any[])
    .filter(c => c.type === "linear" && c.op === "<=" && Array.isArray(c.terms))
    .filter(c => c.terms.every((t: any) => typeof t.var === "string" && t.var.startsWith("y_") && t.coeff === 1))
    .map(c => ({ termCount: c.terms.length, rhs: c.rhs, op: c.op }));
}

beforeEach(() => {
  __resetCircuitState();
  capturedRequest = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver C7/C8 cross-week windows", () => {
  // wk0 Monday = 2026-04-27. Seven consecutive days Wed wk0 → Tue wk1:
  //   wk0: 2026-04-29, 04-30, 05-01, 05-02, 05-03   (Wed..Sun)
  //   wk1: 2026-05-04, 05-05                         (Mon..Tue)
  const dates7Consecutive = [
    { date: "2026-04-29", week: 0 },
    { date: "2026-04-30", week: 0 },
    { date: "2026-05-01", week: 0 },
    { date: "2026-05-02", week: 0 },
    { date: "2026-05-03", week: 0 },
    { date: "2026-05-04", week: 1 },
    { date: "2026-05-05", week: 1 },
  ];

  function multiWeekCfg(workerId: string, numWeeks: number): MultiWeekConfig {
    return {
      numWeeks,
      existingHoursByWeek: new Map([[workerId, new Array(numWeeks).fill(0)]]),
      c9BaseHours: new Map([[workerId, new Array(numWeeks).fill(0)]]),
      c9BaseWeeks: new Map([[workerId, new Array(numWeeks).fill(0)]]),
    };
  }

  test("emits a C7 7-day window constraint that spans the week boundary", async () => {
    const worker = makeWorker("w1");
    const slots = dates7Consecutive.map((d, i) => makeSlot(i + 1, d.date, d.week));

    await solveCPSAT(
      [worker], slots, makeConfig(), alwaysAvailable,
      multiWeekCfg(worker.id, 2),
    );

    expect(capturedRequest).not.toBeNull();
    // In multi-week mode with 7 consecutive days on a single worker, the C7
    // cap (6) must bind: some linear constraint must sum 7 indicator vars
    // with rhs=6. Without cross-week indicator unification, the two
    // sub-windows (5 days wk0 + 2 days wk1) would never be summed together
    // and this constraint would not appear.
    const windows = indicatorWindowConstraints(capturedRequest);
    const c7Binding = windows.find(w => w.termCount === 7 && w.rhs === 6);
    expect(c7Binding).toBeDefined();
  });

  test("emits a C8 7-day window constraint that spans the week boundary", async () => {
    const worker = makeWorker("w1");
    const slots = dates7Consecutive.map((d, i) => makeSlot(i + 1, d.date, d.week));

    await solveCPSAT(
      [worker], slots, makeConfig(), alwaysAvailable,
      multiWeekCfg(worker.id, 2),
    );

    expect(capturedRequest).not.toBeNull();
    // Same shape as C7 but rhs=5 (maxRollingWorkDays).
    const windows = indicatorWindowConstraints(capturedRequest);
    const c8Binding = windows.find(w => w.termCount === 7 && w.rhs === 5);
    expect(c8Binding).toBeDefined();
  });

  test("6 consecutive days across wk boundary: no binding 7-day C7 window", async () => {
    // Fri wk0 → Wed wk1 = 6 consecutive days (spans boundary, not binding for C7=6).
    const dates6 = [
      { date: "2026-05-01", week: 0 }, // Fri
      { date: "2026-05-02", week: 0 }, // Sat
      { date: "2026-05-03", week: 0 }, // Sun
      { date: "2026-05-04", week: 1 }, // Mon
      { date: "2026-05-05", week: 1 }, // Tue
      { date: "2026-05-06", week: 1 }, // Wed
    ];
    const worker = makeWorker("w1");
    const slots = dates6.map((d, i) => makeSlot(i + 1, d.date, d.week));

    await solveCPSAT(
      [worker], slots, makeConfig(), alwaysAvailable,
      multiWeekCfg(worker.id, 2),
    );

    const windows = indicatorWindowConstraints(capturedRequest);
    // With only 6 consecutive days, no 7-term window can form, and any 6-term
    // window has `indicatorTerms.length > rhs` → 6 > 6 false → C7 not emitted.
    const c7Binding = windows.find(w => w.termCount >= 7 && w.rhs === 6);
    expect(c7Binding).toBeUndefined();
    // C8 (rhs=5) still binds on 6-day window: 6 > 5 → emitted.
    const c8Binding = windows.find(w => w.termCount === 6 && w.rhs === 5);
    expect(c8Binding).toBeDefined();
  });
});
