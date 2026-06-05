import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  solveWithTiers,
  greedyFallback,
  tierSolvers,
} from "./solver-tiers.js";
import type {
  ILPResult,
  ILPConfig,
  ILPSlot,
  ILPWorker,
  AvailabilityChecker,
} from "./ilp-solver.js";

function fakeResult(overrides: Partial<ILPResult> = {}): ILPResult {
  return {
    status: "optimal",
    assignments: [],
    solveTimeMs: 1,
    stats: { variables: 0, constraints: 0, workers: 0, slots: 0 },
    ...overrides,
  };
}

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

const openChecker: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

const origSolve = tierSolvers.solve;

beforeEach(() => {
  tierSolvers.solve = origSolve;
  delete process.env.SOLVER_MAX_TIER;
});

afterEach(() => {
  tierSolvers.solve = origSolve;
  delete process.env.SOLVER_MAX_TIER;
});

describe("solveWithTiers", () => {
  test("Tier 0: feasible primary solve returns immediately with solveTier=0", async () => {
    let calls = 0;
    tierSolvers.solve = async () => {
      calls++;
      return fakeResult({ status: "optimal" });
    };
    const res = await solveWithTiers([], [], baseConfig(), openChecker);
    expect(calls).toBe(1);
    expect(res.solveTier).toBe(0);
    expect(res.status).toBe("optimal");
    expect(res.relaxations).toBeUndefined();
    expect(res.unfilledSlots).toBeUndefined();
  });

  test("Tier 1: infeasible Tier 0 + feasible Tier 1 returns unfilledSlots", async () => {
    const slots = [
      slot({ id: 0, target: 2 }),
      slot({ id: 1, target: 1, startTime: "15:00", endTime: "19:00" }),
    ];
    const workers = [worker({ id: "w1", name: "Alice" })];

    let tier = 0;
    tierSolvers.solve = async (_w, _s, cfg) => {
      if (tier === 0) {
        tier++;
        expect(cfg.softSlotPenalty).toBeUndefined();
        return fakeResult({ status: "infeasible" });
      }
      // Tier 1: soft floors enabled. Fill slot 1 completely, slot 0 short by one.
      expect(cfg.softSlotPenalty).toBeGreaterThan(0);
      return fakeResult({
        status: "optimal",
        assignments: [
          { workerId: "w1", workerName: "Alice", slotId: 0 },
          { workerId: "w1", workerName: "Alice", slotId: 1 },
        ],
      });
    };

    const res = await solveWithTiers(workers, slots, baseConfig(), openChecker, undefined, undefined, undefined, 1);
    expect(res.solveTier).toBe(1);
    expect(res.relaxations).toEqual(["soft-slot-floors"]);
    expect(res.unfilledSlots).toEqual([{ slotId: 0, shortage: 1 }]);
  });

  test("underfilled feasible results continue to Tier 2 and report bypassed rest warnings", async () => {
    const slots = [slot({ id: 0, date: "2026-04-25", dow: 6, target: 1 })];
    const workers = [
      worker({
        id: "w1",
        name: "Alice",
        existingWorkDates: new Set(["2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24"]),
      }),
    ];

    let callIdx = 0;
    tierSolvers.solve = async (_w, _s, cfg) => {
      callIdx++;
      if (callIdx === 1) {
        expect(cfg.softSlotPenalty).toBeUndefined();
        return fakeResult({ status: "optimal", assignments: [] });
      }
      if (callIdx === 2) {
        expect(cfg.softSlotPenalty).toBeGreaterThan(0);
        return fakeResult({ status: "optimal", assignments: [] });
      }
      expect(cfg.disabledRules.has("HCR-L3132-2")).toBe(true);
      return fakeResult({
        status: "optimal",
        assignments: [{ workerId: "w1", workerName: "Alice", slotId: 0 }],
      });
    };

    const res = await solveWithTiers(workers, slots, baseConfig({ maxRollingWorkDays: 5 }), openChecker, undefined, undefined, undefined, 2);
    expect(callIdx).toBe(3);
    expect(res.solveTier).toBe(2);
    expect(res.unfilledSlots).toEqual([]);
    expect(res.complianceWarnings).toContainEqual({ workerId: "w1", rule: "HCR-L3132-2", excessHours: 1 });
  });

  test("Tier 2: soft C5 + bypass C7/C8 returns complianceWarnings", async () => {
    process.env.SOLVER_MAX_TIER = "3";
    const slots = [
      slot({ id: 0, hours: 10 }),
      slot({ id: 1, hours: 10, startTime: "15:00", endTime: "01:00" }),
    ];
    const workers = [
      worker({ id: "w1", name: "Alice", contractHours: 35, existingWeeklyHours: 40 }),
    ];

    let callIdx = 0;
    tierSolvers.solve = async (_w, _s, cfg) => {
      callIdx++;
      if (callIdx === 1) return fakeResult({ status: "infeasible" });
      if (callIdx === 2) {
        expect(cfg.softSlotPenalty).toBeGreaterThan(0);
        return fakeResult({ status: "infeasible" });
      }
      // Tier 2
      expect(cfg.softC5Penalty).toBeGreaterThan(0);
      expect(cfg.softC5ExtraHours).toBe(2);
      expect(cfg.disabledRules.has("HCR-L3132-1")).toBe(true);
      expect(cfg.disabledRules.has("HCR-L3132-2")).toBe(true);
      return fakeResult({
        status: "feasible",
        assignments: [
          { workerId: "w1", workerName: "Alice", slotId: 0 },
          { workerId: "w1", workerName: "Alice", slotId: 1 },
        ],
      });
    };

    const res = await solveWithTiers(workers, slots, baseConfig(), openChecker, undefined, undefined, undefined, 2);
    expect(callIdx).toBe(3);
    expect(res.solveTier).toBe(2);
    expect(res.relaxations).toEqual([
      "soft-slot-floors",
      "soft-ot-cap",
      "bypass-C7",
      "bypass-C8",
    ]);
    // w1: 40 existing + 20 planned = 60, legal cap = 48 → excess 12
    expect(res.complianceWarnings).toEqual([
      { workerId: "w1", rule: "HCR-L3121-20", excessHours: 12 },
    ]);
  });

  test("Tier 3: all solver tiers infeasible → greedy fallback, degraded=true", async () => {
    process.env.SOLVER_MAX_TIER = "3";
    const workers = [worker({ id: "w1", name: "Alice" })];
    const slots = [slot({ id: 0, target: 1 })];

    tierSolvers.solve = async () => fakeResult({ status: "infeasible" });

    const res = await solveWithTiers(workers, slots, baseConfig(), openChecker, undefined, undefined, undefined, 3);
    expect(res.solveTier).toBe(3);
    expect(res.degraded).toBe(true);
    expect(res.status).toBe("feasible");
    expect(res.relaxations).toEqual(["greedy-fallback"]);
    expect(res.assignments).toHaveLength(1);
    expect(res.assignments[0].workerId).toBe("w1");
  });

  test("Tier 4: exceptional crisis pass may fill up to 60h and reports the 48h violation", async () => {
    process.env.SOLVER_MAX_TIER = "4";
    const workers = [worker({ id: "w1", name: "Alice", existingWeeklyHours: 45 })];
    const slots = [slot({ id: 0, hours: 5, target: 1 })];

    tierSolvers.solve = async () => fakeResult({ status: "infeasible" });

    const res = await solveWithTiers(workers, slots, baseConfig(), openChecker, undefined, undefined, undefined, 4);
    expect(res.solveTier).toBe(4);
    expect(res.relaxations).toEqual(["greedy-fallback", "exceptional-60h-cap"]);
    expect(res.unfilledSlots).toEqual([]);
    expect(res.assignments).toHaveLength(1);
    expect(res.complianceWarnings).toContainEqual({
      workerId: "w1",
      rule: "HCR-L3121-20",
      excessHours: 2,
    });
  });

  test("maxTier ceiling: maxTier=0 returns Tier 0 infeasible without retrying", async () => {
    let calls = 0;
    tierSolvers.solve = async () => {
      calls++;
      return fakeResult({ status: "infeasible" });
    };
    const res = await solveWithTiers([], [], baseConfig(), openChecker, undefined, undefined, undefined, 0);
    expect(calls).toBe(1);
    expect(res.solveTier).toBe(0);
    expect(res.status).toBe("infeasible");
  });

  test("SOLVER_MAX_TIER env clamps ceiling below request", async () => {
    process.env.SOLVER_MAX_TIER = "1";
    let calls = 0;
    tierSolvers.solve = async () => {
      calls++;
      return fakeResult({ status: "infeasible" });
    };
    // Caller asks for tier 3, but env caps at 1: should make two calls (tier 0, tier 1) then stop.
    const res = await solveWithTiers([], [slot({ id: 0 })], baseConfig(), openChecker, undefined, undefined, undefined, 3);
    expect(calls).toBe(2);
    expect(res.solveTier).toBe(1);
  });

  test("maxTier=1: stops at Tier 1 even when infeasible", async () => {
    let calls = 0;
    tierSolvers.solve = async () => {
      calls++;
      return fakeResult({ status: "infeasible" });
    };
    const res = await solveWithTiers([], [], baseConfig(), openChecker, undefined, undefined, undefined, 1);
    expect(calls).toBe(2);
    expect(res.solveTier).toBe(1);
  });
});

describe("greedyFallback", () => {
  test("covers simple single-worker single-slot case", () => {
    const workers = [worker({ id: "w1", name: "Alice" })];
    const slots = [slot({ id: 0, target: 1 })];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    expect(res.assignments).toHaveLength(1);
    expect(res.unfilledSlots).toEqual([]);
    expect(res.degraded).toBe(true);
    expect(res.solveTier).toBe(3);
  });

  test("respects 48h hard cap", () => {
    const workers = [worker({ id: "w1", name: "Alice", existingWeeklyHours: 45 })];
    const slots = [
      slot({ id: 0, hours: 4, target: 1 }),
      slot({ id: 1, hours: 4, target: 1, startTime: "15:00", endTime: "19:00" }),
    ];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    // w1 has 45 existing + can take max one 4h slot (= 49 blocked, so none fit).
    // Actually 45 + 4 = 49 > 48 → 0 slots. Every candidate filtered out.
    expect(res.assignments).toHaveLength(0);
    expect(res.unfilledSlots).toHaveLength(2);
  });

  test("emits GREEDY_48H_CAP warning when cap is the binding reason for an unfilled slot", () => {
    // L17: the 48h hard cap used to be silent. When the cap is the only thing
    // blocking fill (earlier filters would have passed a candidate), surface it
    // through complianceWarnings so operators have a signal.
    const workers = [worker({ id: "w1", name: "Alice", existingWeeklyHours: 45 })];
    const slots = [slot({ id: 0, hours: 10, target: 1 })];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    // 45 + 10 = 55 > 48 → slot goes unfilled and the cap is the binding reason.
    expect(res.assignments).toHaveLength(0);
    expect(res.unfilledSlots).toEqual([{ slotId: 0, shortage: 1 }]);
    const capWarnings = (res.complianceWarnings ?? []).filter(w => w.rule === "GREEDY_48H_CAP");
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]).toMatchObject({ workerId: "w1", rule: "GREEDY_48H_CAP", excessHours: 7 });
  });

  test("does not emit GREEDY_48H_CAP warning when an earlier filter is the binding reason", () => {
    // Role mismatch cuts the candidate before the cap filter sees it; cap never binds.
    const workers = [worker({ id: "w1", name: "Alice", role: "floor", existingWeeklyHours: 45 })];
    const slots = [slot({ id: 0, role: "kitchen", hours: 10, target: 1 })];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    expect(res.assignments).toHaveLength(0);
    const capWarnings = (res.complianceWarnings ?? []).filter(w => w.rule === "GREEDY_48H_CAP");
    expect(capWarnings).toHaveLength(0);
  });

  test("does not emit GREEDY_48H_CAP warning when another worker fills the slot", () => {
    // Two workers: one cap-blocked, one free. Slot still gets filled, so no warning.
    const workers = [
      worker({ id: "w1", name: "Alice", existingWeeklyHours: 45 }),
      worker({ id: "w2", name: "Bob", existingWeeklyHours: 0 }),
    ];
    const slots = [slot({ id: 0, hours: 10, target: 1 })];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    expect(res.assignments).toHaveLength(1);
    const capWarnings = (res.complianceWarnings ?? []).filter(w => w.rule === "GREEDY_48H_CAP");
    expect(capWarnings).toHaveLength(0);
  });

  test("skips overlapping slots for the same worker", () => {
    const workers = [worker({ id: "w1", name: "Alice" })];
    const slots = [
      slot({ id: 0, startTime: "10:00", endTime: "14:00", target: 1 }),
      slot({ id: 1, startTime: "12:00", endTime: "16:00", target: 1 }), // overlaps
    ];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    expect(res.assignments).toHaveLength(1);
    // One slot remains unfilled due to overlap.
    expect(res.unfilledSlots).toHaveLength(1);
  });

  test("ranks slots by (target-existingFill) × day priority", () => {
    const workers = [worker({ id: "w1", name: "Alice" })];
    const slots = [
      slot({ id: 0, dow: 1, target: 1, startTime: "10:00", endTime: "12:00", hours: 2 }),
      slot({ id: 1, dow: 5, target: 1, startTime: "15:00", endTime: "17:00", hours: 2 }),
    ];
    const cfg = baseConfig({ dayPriorityMap: { "5": 10, "1": 1 } });
    // Worker can take both (2 + 2 = 4 hours), but verify ordering anyway
    // by giving them a tight cap so only one can be assigned.
    const tightWorkers = [worker({ id: "w1", name: "Alice", existingWeeklyHours: 45 })];
    // Now only one 2h slot fits (45 + 2 = 47 <= 48). Should pick slot id=1 (dow 5 × 10 = 10).
    const res = greedyFallback(tightWorkers, slots, cfg, openChecker);
    expect(res.assignments).toHaveLength(1);
    expect(res.assignments[0].slotId).toBe(1);
  });

  test("filters by role", () => {
    const workers = [worker({ id: "w1", name: "Alice", role: "floor" })];
    const slots = [slot({ id: 0, role: "kitchen", target: 1 })];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    expect(res.assignments).toHaveLength(0);
    expect(res.unfilledSlots).toEqual([{ slotId: 0, shortage: 1 }]);
  });

  test("respects availability checker", () => {
    const workers = [worker({ id: "w1", name: "Alice" })];
    const slots = [slot({ id: 0, target: 1 })];
    const closed: AvailabilityChecker = { isAvailable: () => false, prefersSlot: () => false };
    const res = greedyFallback(workers, slots, baseConfig(), closed);
    expect(res.assignments).toHaveLength(0);
  });

  test("commits compound pairs atomically", () => {
    const workers = [worker({ id: "w1", name: "Alice" })];
    const slots = [
      slot({ id: 0, compound: true, compoundPairId: 1, startTime: "10:00", endTime: "14:00", hours: 4, target: 1 }),
      slot({ id: 1, compound: true, compoundPairId: 0, startTime: "18:00", endTime: "23:00", hours: 5, target: 1 }),
    ];
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    // Both halves of the pair must go to the same worker.
    expect(res.assignments).toHaveLength(2);
    expect(res.assignments[0].workerId).toBe("w1");
    expect(res.assignments[1].workerId).toBe("w1");
    const slotIds = res.assignments.map(a => a.slotId).sort();
    expect(slotIds).toEqual([0, 1]);
  });

  test("skips compound pair when one half violates the cap", () => {
    const workers = [worker({ id: "w1", name: "Alice", existingWeeklyHours: 42 })];
    const slots = [
      slot({ id: 0, compound: true, compoundPairId: 1, hours: 4, target: 1 }),
      slot({ id: 1, compound: true, compoundPairId: 0, startTime: "18:00", endTime: "23:00", hours: 5, target: 1 }),
    ];
    // 42 + 4 + 5 = 51 > 48 → should skip both halves.
    const res = greedyFallback(workers, slots, baseConfig(), openChecker);
    expect(res.assignments).toHaveLength(0);
  });
});
