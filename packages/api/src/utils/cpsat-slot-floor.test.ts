import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker, SlotFillFloors } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for C1b slot-fill-floor "representative slot" bug.
// Before the fix, slots sharing a (week, dow, role, zone) group were
// collapsed to a single representative and only its assignment vars summed
// into the floor. Sibling slots were silently dropped, producing spurious
// soft penalties or masking true infeasibility with template overrides.

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
          .map(v => [v.name, 0]),
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

function makeSlot(id: number, date: string, startTime: string, endTime: string, existingFill = 0): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone: "floor",
    role: "floor" as any,
    startTime,
    endTime,
    hours: 4,
    target: 2,
    existingFill,
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

// 2026-04-27 is a Monday — dow=1 under UTC.
const GROUP_KEY = "0_1_floor_floor";

beforeEach(() => {
  __resetCircuitState();
  capturedRequest = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver C1b slot-fill-floor group sum", () => {
  test("hard floor sums vars across every slot in the group, not just one rep", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    // Two non-compound slots in the same (week=0, dow=1, floor, floor) group.
    const slots = [
      makeSlot(1, "2026-04-27", "11:00", "15:00"),
      makeSlot(2, "2026-04-27", "18:00", "22:00"),
    ];
    const floors: SlotFillFloors = new Map([[GROUP_KEY, 2]]);

    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable, undefined, floors);

    expect(capturedRequest).not.toBeNull();
    const hardFloors = (capturedRequest.constraints as any[]).filter(
      c => c.type === "linear" && c.op === ">=" && c.rhs === 2
        && Array.isArray(c.terms) && c.terms.every((t: any) => t.coeff === 1),
    );
    expect(hardFloors).toHaveLength(1);

    // 2 workers × 2 slots = 4 assignment vars must appear in the group sum.
    const varNames = new Set<string>(hardFloors[0].terms.map((t: any) => t.var));
    expect(varNames.size).toBe(4);
  });

  test("soft floor is emitted per group with a group-keyed id", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slots = [
      makeSlot(1, "2026-04-27", "11:00", "15:00"),
      makeSlot(2, "2026-04-27", "18:00", "22:00"),
    ];
    const cfg = makeConfig();
    cfg.softSlotPenalty = 1000;
    const floors: SlotFillFloors = new Map([[GROUP_KEY, 2]]);

    await solveCPSAT(workers, slots, cfg, alwaysAvailable, undefined, floors);

    const softFloor = (capturedRequest.constraints as any[]).find(
      c => c.type === "soft_linear" && c.id === `floor_${GROUP_KEY}`,
    );
    expect(softFloor).toBeDefined();
    expect(softFloor.op).toBe(">=");
    expect(softFloor.rhs).toBe(2);
    expect(softFloor.penalty).toBe(1000);
    expect(softFloor.terms).toHaveLength(4);
  });

  test("totalExistingFill sums across all siblings, not just one rep", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    // Both slots pre-filled by 1 each → total 2 → floor=3 → needed=1.
    // Under the rep-slot bug needed would compute as 3-1=2 (only one slot's fill).
    const slots = [
      makeSlot(1, "2026-04-27", "11:00", "15:00", 1),
      makeSlot(2, "2026-04-27", "18:00", "22:00", 1),
    ];
    const floors: SlotFillFloors = new Map([[GROUP_KEY, 3]]);

    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable, undefined, floors);

    const hardFloors = (capturedRequest.constraints as any[]).filter(
      c => c.type === "linear" && c.op === ">="
        && Array.isArray(c.terms) && c.terms.every((t: any) => t.coeff === 1),
    );
    const groupFloor = hardFloors.find(c => c.terms.length === 4);
    expect(groupFloor).toBeDefined();
    expect(groupFloor.rhs).toBe(1);
  });

  test("compound pair dedup preserved — higher-id sibling is excluded from group sum", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const a = makeSlot(10, "2026-04-27", "11:00", "15:00");
    const b = makeSlot(11, "2026-04-27", "18:00", "22:00");
    a.compound = true; a.compoundPairId = 11;
    b.compound = true; b.compoundPairId = 10;
    const cfg = makeConfig();
    cfg.softSlotPenalty = 1000;
    const floors: SlotFillFloors = new Map([[GROUP_KEY, 2]]);

    await solveCPSAT(workers, [a, b], cfg, alwaysAvailable, undefined, floors);

    const softFloor = (capturedRequest.constraints as any[]).find(
      c => c.type === "soft_linear" && c.id === `floor_${GROUP_KEY}`,
    );
    expect(softFloor).toBeDefined();
    // Slot 11 deduped; only slot 10's vars appear → 2 workers × 1 slot = 2 vars.
    expect(softFloor.terms).toHaveLength(2);
  });
});
