/**
 * Integration test for the C9 freshness gate inside solveILP.
 *
 * Confirms that the gate classifies workers correctly, widens or skips the
 * rolling-average cap, and reports the diagnostics on the returned ILPResult.
 *
 * The ILP is built with HiGHS WASM, which is slow to init but reuses the
 * cached instance across tests. Each case uses a tiny fixture (1 worker,
 * ~1 slot) so solve time stays negligible.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { solveILP, type ILPConfig, type ILPWorker, type ILPSlot, type AvailabilityChecker, type MultiWeekConfig } from "./ilp-solver.js";

function baseConfig(over: Partial<ILPConfig> = {}): ILPConfig {
  return {
    maxDailyHoursCompound: 11,
    minRestHours: 11,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 6,
    max12WeekAvgHours: 46,
    otCap: 48,
    disabledRules: new Set<string>(),
    otDistribution: "even",
    dayPriorityMap: {},
    prefEnabled: false,
    templates: [],
    ...over,
  };
}

function worker(over: Partial<ILPWorker> & { id: string; name: string }): ILPWorker {
  return {
    role: "kitchen",
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
    historicalWeeks: 0,
    consistency: new Map(),
    flexibility: 0,
    ...over,
  };
}

function slot(over: Partial<ILPSlot> & { id: number }): ILPSlot {
  return {
    date: "2026-04-20",
    dow: 1,
    zone: "kitchen-lunch",
    role: "kitchen",
    startTime: "10:00",
    endTime: "14:00",
    hours: 4,
    target: 1,
    existingFill: 0,
    compound: false,
    ...over,
  };
}

const openChecker: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

const prevGateEnv = process.env.C9_FRESHNESS_GATE;
afterEach(() => {
  if (prevGateEnv === undefined) delete process.env.C9_FRESHNESS_GATE;
  else process.env.C9_FRESHNESS_GATE = prevGateEnv;
});

describe.skip("C9 freshness gate (single-week via legacy solveILP)", () => {
  test("high-confidence worker gets C9 classification surfaced; solve feasible", async () => {
    // 11/12 weeks of data, 530h historical (just under the 552 cap).
    // One 4h slot available, worker has 0 existing hours this week, so
    // remaining C9 budget = 552 - 530 - 0 = 22h; the 4h slot easily fits.
    const w = worker({
      id: "w1",
      name: "Alice",
      historicalHours: 530,
      historicalWeeks: 11,
    });
    const s = slot({ id: 0 });
    const res = await solveILP([w], [s], baseConfig(), openChecker);
    expect(res.status).toBe("optimal");
    expect(res.c9Confidence?.["w1"]).toBe("high");
    expect(res.c9Skipped).toEqual([]);
    expect(res.assignments).toHaveLength(1);
  });

  test("medium-confidence applies cap normally", async () => {
    const w = worker({
      id: "w1",
      name: "Alice",
      historicalHours: 100,
      historicalWeeks: 7, // 7/12 = 0.58 → medium
    });
    const s = slot({ id: 0 });
    const res = await solveILP([w], [s], baseConfig(), openChecker);
    expect(res.c9Confidence?.["w1"]).toBe("medium");
    expect(res.c9Skipped).toEqual([]);
    expect(res.status).toBe("optimal");
  });

  test("low-confidence widens cap by 10 %: worker at boundary fits only with widening", async () => {
    // 4/12 = 0.33 → low. Base cap = 46*12 = 552. Widened = 607.2.
    // Put worker at 555h historical — above base but below widened.
    // With one 4h slot, needed capacity = 4h; remaining widened = 607.2 - 555 = 52.2 → fits.
    // To confirm gate is ACTIVE and not "none" (which would skip entirely),
    // we check confidence classification too.
    const w = worker({
      id: "w1",
      name: "Alice",
      historicalHours: 555,
      historicalWeeks: 4,
    });
    const s = slot({ id: 0 });
    const res = await solveILP([w], [s], baseConfig(), openChecker);
    expect(res.c9Confidence?.["w1"]).toBe("low");
    expect(res.c9Skipped).toEqual([]);
    expect(res.status).toBe("optimal");
    expect(res.assignments).toHaveLength(1);
  });

  test("no-history worker (none): C9 is skipped, worker listed in c9Skipped", async () => {
    // 1/12 = 0.08 → none. Even with huge historicalHours, C9 must be skipped.
    const w = worker({
      id: "w1",
      name: "Alice",
      historicalHours: 10000, // absurdly high — would infeasibilize if C9 applied
      historicalWeeks: 1,
    });
    const s = slot({ id: 0 });
    const res = await solveILP([w], [s], baseConfig(), openChecker);
    expect(res.c9Confidence?.["w1"]).toBe("none");
    expect(res.c9Skipped).toContain("w1");
    expect(res.status).toBe("optimal");
    expect(res.assignments).toHaveLength(1);
  });

  test("bootstrap worker: C9 skipped regardless of history", async () => {
    // Worker is "new" (bootstrapC9=true). Even though they appear to have
    // 12 weeks of high history, we treat the data as untrustworthy.
    const w = worker({
      id: "w1",
      name: "Alice",
      historicalHours: 600, // would violate cap if applied
      historicalWeeks: 12,
      bootstrapC9: true,
    });
    const s = slot({ id: 0 });
    const res = await solveILP([w], [s], baseConfig(), openChecker);
    expect(res.c9Skipped).toContain("w1");
    expect(res.status).toBe("optimal");
    expect(res.assignments).toHaveLength(1);
  });

  test("gate disabled via env: C9 applies exactly as before (skip depends on raw thresholds)", async () => {
    process.env.C9_FRESHNESS_GATE = "0";
    // Worker has 12/12 weeks & 600h history — with gate disabled, C9 applies,
    // exceeds cap, and the slot can't be filled.
    const w = worker({
      id: "w1",
      name: "Alice",
      historicalHours: 600,
      historicalWeeks: 12,
    });
    const s = slot({ id: 0 });
    const res = await solveILP([w], [s], baseConfig(), openChecker);
    // Confidence is still reported (for diagnostics) but gate was disabled.
    expect(res.c9Confidence?.["w1"]).toBe("high");
    expect(res.c9Skipped).toEqual([]);
    // Slot can't be filled since remaining = 552 - 600 < 0.
    expect(res.assignments).toHaveLength(0);
  });
});

describe.skip("C9 freshness gate (multi-week via legacy solveILP)", () => {
  test("new restaurant: all workers bootstrap → C9 skipped, solve feasible", async () => {
    // Simulate 2 weeks of history (via c9BaseWeeks) on fresh workers.
    // With bootstrapC9=true, gate must skip C9 for both workers.
    const workers: ILPWorker[] = [
      worker({ id: "w1", name: "Alice", historicalHours: 70, historicalWeeks: 2, bootstrapC9: true }),
      worker({ id: "w2", name: "Bob",   historicalHours: 80, historicalWeeks: 2, bootstrapC9: true }),
    ];
    const slots: ILPSlot[] = [
      slot({ id: 0, date: "2026-04-20", week: 0 }),
      slot({ id: 1, date: "2026-04-27", week: 1 }),
    ];
    const multiWeek: MultiWeekConfig = {
      numWeeks: 2,
      existingHoursByWeek: new Map([["w1", [0, 0]], ["w2", [0, 0]]]),
      c9BaseHours: new Map([["w1", [70, 70]], ["w2", [80, 80]]]),
      c9BaseWeeks: new Map([["w1", [2, 2]], ["w2", [2, 2]]]),
    };
    const res = await solveILP(workers, slots, baseConfig(), openChecker, multiWeek);
    expect(res.status).toBe("optimal");
    expect(res.c9Skipped).toContain("w1");
    expect(res.c9Skipped).toContain("w2");
    expect(res.assignments.length).toBeGreaterThan(0);
  });
});
