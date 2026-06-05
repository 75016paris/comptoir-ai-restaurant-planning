import { describe, test, expect } from "bun:test";
import { PRESETS } from "@comptoir/shared";
import { solveILP, type AvailabilityChecker, type ILPConfig, type ILPSlot, type ILPWorker, type SlotFillFloors } from "./ilp-solver.js";

function makeWorker(id: string, existingWeeklyHours: number, priority: number, overrides: Partial<ILPWorker> = {}): ILPWorker {
  return {
    id,
    name: id,
    role: "kitchen",
    priority,
    overtimeWilling: true,
    contractHours: 35,
    otCap: 48,
    subRoles: ["Cuisine"],
    existingWeeklyHours,
    existingWorkDates: new Set(),
    existingDailyHours: new Map(),
    existingLastEnd: new Map(),
    existingFirstStart: new Map(),
    existingServicesByDate: new Map(),
    historicalHours: 0,
    historicalWeeks: 4,
    consistency: new Map(),
    flexibility: 1,
    ...overrides,
  };
}

function makeSlot(): ILPSlot {
  return {
    id: 1,
    date: "2026-04-27",
    dow: 1,
    zone: "Midi",
    role: "kitchen",
    startTime: "09:00",
    endTime: "13:00",
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
    otCap: 48,
    disabledRules: new Set(),
    otDistribution: "equal",
    dayPriorityMap: {},
    prefEnabled: false,
    templates: [],
    softC5Penalty: 2_000_000,
    softC5ExtraHours: 2,
  };
}

const alwaysAvailable: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

describe("ILP weekly hard cap", () => {
  test("Tier 2 soft C5 cannot assign a worker above the HCR 48h absolute weekly cap", async () => {
    const nearLegalCap = makeWorker("near-legal-cap", 45, 1);
    const fallback = makeWorker("fallback", 0, 2);

    const result = await solveILP([nearLegalCap, fallback], [makeSlot()], makeConfig(), alwaysAvailable);

    expect(result.status === "optimal" || result.status === "feasible").toBe(true);
    expect(result.assignments.some(a => a.workerId === "near-legal-cap")).toBe(false);
    expect(result.assignments.some(a => a.workerId === "fallback")).toBe(true);
  });

  test("extra contracts with 0 guaranteed hours remain staffable", async () => {
    const extra = makeWorker("extra", 0, 1, {
      contractType: "extra",
      contractHours: 0,
      otCap: 48,
    });
    const floors: SlotFillFloors = new Map([["0_1_kitchen_Midi", 1]]);

    const result = await solveILP([extra], [makeSlot()], makeConfig(), alwaysAvailable, undefined, floors);

    expect(result.status === "optimal" || result.status === "feasible").toBe(true);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].workerId).toBe("extra");
  });

  test("economique prefers completing a CDI contract before assigning an extra", async () => {
    const underContractCdi = makeWorker("cdi-shared", 30, 1, {
      contractType: "CDI",
      contractHours: 35,
      assignmentPoolPenalty: 80,
      hourlyRateCents: 1200,
    });
    const extra = makeWorker("extra-local", 0, 1, {
      contractType: "extra",
      contractHours: 0,
      otCap: 48,
      hourlyRateCents: 1200,
    });
    const floors: SlotFillFloors = new Map([["0_1_kitchen_Midi", 1]]);

    const result = await solveILP([extra, underContractCdi], [makeSlot()], makeConfig(), alwaysAvailable, undefined, floors, PRESETS.economique);

    expect(result.status === "optimal" || result.status === "feasible").toBe(true);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].workerId).toBe("cdi-shared");
  });
});
