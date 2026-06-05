import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Regression test for audit finding H6:
// `softC5Penalty` is declared per-hour (see ILPConfig JSDoc) and the ILP
// backend applies it per-hour. CP-SAT's C5 soft_linear expression is in
// minutes (coeff = slot.hours × SCALE, rhs in minutes), so the emitted
// `penalty` on the payload must be softC5Penalty / SCALE (per-minute
// equivalent of the per-hour constant). Before the fix the raw per-hour
// value was passed through, making one hour of C5 violation cost 60× the
// documented intent.

const SCALE = 60;
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

function makeWorker(id: string, existingWeeklyHours = 0): ILPWorker {
  return {
    id,
    name: id,
    role: "floor" as any,
    priority: 1,
    overtimeWilling: false,
    contractHours: 35,
    subRoles: [],
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
  };
}

function makeSlot(id: number, date: string, startTime: string, endTime: string, hours: number): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone: "floor",
    role: "floor" as any,
    startTime,
    endTime,
    hours,
    target: 1,
    existingFill: 0,
    compound: false,
  };
}

function makeConfig(softC5Penalty?: number): ILPConfig {
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
    softC5Penalty,
    softC5ExtraHours: 2,
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

describe("cpsat-solver C5 soft penalty unit conversion (H6)", () => {
  test("single-week: emitted penalty is softC5Penalty / SCALE (per-minute equivalent of per-hour constant)", async () => {
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "2026-04-27", "09:00", "17:00", 8),
      makeSlot(2, "2026-04-28", "09:00", "17:00", 8),
    ];
    const perHourPenalty = 2_000_000;

    await solveCPSAT(workers, slots, makeConfig(perHourPenalty), alwaysAvailable);

    expect(capturedRequest).not.toBeNull();
    const c5 = (capturedRequest.constraints as any[]).find(
      c => c.type === "soft_linear" && c.id === "c5_w1",
    );
    expect(c5).toBeDefined();
    expect(c5.penalty).toBe(Math.round(perHourPenalty / SCALE));
    expect(c5.penalty).toBe(33_333);
  });

  test("multi-week: every c5_<worker>_<wk> constraint carries the per-minute-scaled penalty", async () => {
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "2026-04-27", "09:00", "17:00", 8),
      makeSlot(2, "2026-05-04", "09:00", "17:00", 8),
    ];
    slots[0].week = 0;
    slots[1].week = 1;
    const perHourPenalty = 2_000_000;
    const multiWeek = {
      numWeeks: 2,
      existingHoursByWeek: new Map<string, number[]>([["w1", [0, 0]]]),
      c9BaseHours: new Map<string, number[]>(),
      c9BaseWeeks: new Map<string, number[]>(),
    };

    await solveCPSAT(workers, slots, makeConfig(perHourPenalty), alwaysAvailable, multiWeek);

    const c5s = (capturedRequest.constraints as any[]).filter(
      c => c.type === "soft_linear" && typeof c.id === "string" && c.id.startsWith("c5_w1_"),
    );
    expect(c5s.length).toBe(2);
    for (const c of c5s) {
      expect(c.penalty).toBe(Math.round(perHourPenalty / SCALE));
    }
  });

  test("penalty is omitted (no soft C5 constraints) when softC5Penalty is absent", async () => {
    const workers = [makeWorker("w1")];
    const slots = [makeSlot(1, "2026-04-27", "09:00", "17:00", 8)];

    await solveCPSAT(workers, slots, makeConfig(undefined), alwaysAvailable);

    const c5s = (capturedRequest.constraints as any[]).filter(
      c => c.type === "soft_linear" && typeof c.id === "string" && c.id.startsWith("c5_"),
    );
    expect(c5s).toHaveLength(0);
  });

  test("soft C5 never relaxes the HCR 48h absolute weekly cap", async () => {
    const worker = makeWorker("w1", 45);
    worker.otCap = 48;
    const workers = [worker];
    const slots = [makeSlot(1, "2026-04-27", "09:00", "13:00", 4)];

    await solveCPSAT(workers, slots, makeConfig(2_000_000), alwaysAvailable);

    const hardWeeklyCap = (capturedRequest.constraints as any[]).find(
      c => c.type === "linear"
        && c.op === "<="
        && c.rhs === 3 * SCALE
        && c.terms?.some((t: any) => t.coeff === 4 * SCALE),
    );
    expect(hardWeeklyCap).toBeDefined();
    const softC5s = (capturedRequest.constraints as any[]).filter(
      c => c.type === "soft_linear" && typeof c.id === "string" && c.id.startsWith("c5_"),
    );
    expect(softC5s).toHaveLength(0);
  });

  test("extra contracts with 0 guaranteed hours get a normal weekly cap instead of being blocked at 0h", async () => {
    const worker = makeWorker("extra", 0);
    worker.contractType = "extra";
    worker.contractHours = 0;
    worker.otCap = 48;
    const slots = [makeSlot(1, "2026-04-27", "09:00", "13:00", 4)];

    await solveCPSAT([worker], slots, makeConfig(undefined), alwaysAvailable);

    const hardWeeklyCap = (capturedRequest.constraints as any[]).find(
      c => c.type === "linear"
        && c.op === "<="
        && c.rhs === 48 * SCALE
        && c.terms?.some((t: any) => t.coeff === 4 * SCALE),
    );
    expect(hardWeeklyCap).toBeDefined();
    const zeroBlock = (capturedRequest.constraints as any[]).find(
      c => c.type === "linear"
        && c.op === "=="
        && c.rhs === 0
        && c.terms?.length === 1
        && c.terms[0]?.var === "x_0",
    );
    expect(zeroBlock).toBeUndefined();
  });

  test("a non-standard per-hour penalty rounds correctly at the per-minute boundary", async () => {
    const workers = [makeWorker("w1")];
    const slots = [makeSlot(1, "2026-04-27", "09:00", "17:00", 8)];
    // 1_000 / 60 = 16.67 → rounds to 17.
    await solveCPSAT(workers, slots, makeConfig(1_000), alwaysAvailable);
    const c5 = (capturedRequest.constraints as any[]).find(
      c => c.type === "soft_linear" && c.id === "c5_w1",
    );
    expect(c5.penalty).toBe(17);
  });

  test("a small per-hour penalty still emits a minimum of 1 per-minute to preserve soft-constraint behavior", async () => {
    const workers = [makeWorker("w1")];
    const slots = [makeSlot(1, "2026-04-27", "09:00", "17:00", 8)];
    // 30 / 60 = 0.5 → rounds to 0; clamp to 1 so the soft constraint isn't silently free.
    await solveCPSAT(workers, slots, makeConfig(30), alwaysAvailable);
    const c5 = (capturedRequest.constraints as any[]).find(
      c => c.type === "soft_linear" && c.id === "c5_w1",
    );
    expect(c5.penalty).toBe(1);
  });
});
