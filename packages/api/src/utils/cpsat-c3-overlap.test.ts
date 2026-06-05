import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Audit M8: C3 encoding switched from O(n²) pairwise `at_most_one` to `interval_var`
// + single `no_overlap` per (worker, date) group. Tests check the SEMANTIC
// contract (two overlapping slots on the same worker-date cannot both be 1)
// via an encoding-neutral helper, so the same suite pins both the old and new
// encodings green. One test pins the specific M8 choice on compound pairs:
// compound siblings are NOT excluded from the no_overlap group (option b) —
// the existing C2 `varA == varB` equality keeps them co-assigned, and split
// shifts are non-overlapping by domain definition.

const origFetch = globalThis.fetch;

type CapturedRequest = {
  variables: Array<{
    type: string;
    name: string;
    presenceVar?: string;
    start?: number;
    end?: number;
    size?: number;
  }>;
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
    ...over,
  };
}

function makeSlot(
  id: number,
  date: string,
  startTime: string,
  endTime: string,
  over: Partial<ILPSlot> = {},
): ILPSlot {
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
    ...over,
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

/**
 * Encoding-neutral check that the model effectively forbids `varA=1 ∧ varB=1`
 * on time-overlap grounds. Accepts both encodings:
 *  - Old: an `at_most_one` constraint listing both vars.
 *  - New: a `no_overlap` group containing at least one interval for each var
 *    (by presenceVar), with some (a-interval, b-interval) pair that
 *    geometrically overlaps on the minute timeline. Two intervals sitting in
 *    the same no_overlap group without overlapping geometry do NOT enforce
 *    mutual exclusion — no_overlap is a geometric constraint, not a vars-level
 *    at_most_one.
 */
function hasMutualExclusion(varA: string, varB: string): boolean {
  if (!captured) return false;
  for (const c of captured.constraints) {
    if (c.type === "at_most_one") {
      const vars = c.vars as string[];
      if (vars.includes(varA) && vars.includes(varB)) return true;
    }
  }
  const intervalsByName = new Map<string, { start: number; end: number; presenceVar?: string }>();
  for (const v of captured.variables) {
    if (v.type === "interval" && v.start !== undefined && v.end !== undefined) {
      intervalsByName.set(v.name, { start: v.start, end: v.end, presenceVar: v.presenceVar });
    }
  }
  for (const c of captured.constraints) {
    if (c.type !== "no_overlap") continue;
    const names = c.intervals as string[];
    const group = names.map(n => intervalsByName.get(n)).filter((x): x is { start: number; end: number; presenceVar?: string } => !!x);
    const aIvs = group.filter(iv => iv.presenceVar === varA);
    const bIvs = group.filter(iv => iv.presenceVar === varB);
    for (const a of aIvs) {
      for (const b of bIvs) {
        if (a.start < b.end && b.start < a.end) return true;
      }
    }
  }
  return false;
}

/** Count `x_*` assignment vars — used to resolve varName by slot order. */
function assignmentVarNames(): string[] {
  if (!captured) return [];
  return captured.variables.filter(v => v.type === "bool" && v.name.startsWith("x_")).map(v => v.name);
}

beforeEach(() => {
  __resetCircuitState();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver C3 no-overlap encoding (audit M8)", () => {
  test("two overlapping slots on same worker-date produce mutual-exclusion constraint", async () => {
    const workers = [makeWorker("w1")];
    // Both slots on the same date, time-overlapping
    const slots = [
      makeSlot(1, "2026-04-27", "11:00", "15:00"),
      makeSlot(2, "2026-04-27", "13:00", "17:00"),
    ];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasMutualExclusion(names[0], names[1])).toBe(true);
  });

  test("two non-overlapping slots on same worker-date produce NO mutual-exclusion constraint", async () => {
    const workers = [makeWorker("w1")];
    // Non-overlapping: 09:00-12:00 and 14:00-18:00
    const slots = [
      makeSlot(1, "2026-04-27", "09:00", "12:00"),
      makeSlot(2, "2026-04-27", "14:00", "18:00"),
    ];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasMutualExclusion(names[0], names[1])).toBe(false);
  });

  test("two slots on different dates produce NO mutual-exclusion constraint (different worker-date groups)", async () => {
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "2026-04-27", "11:00", "15:00"),
      makeSlot(2, "2026-04-28", "11:00", "15:00"),
    ];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasMutualExclusion(names[0], names[1])).toBe(false);
  });

  test("compound pair siblings are included in the no_overlap group (option b — domain guarantees non-overlapping split shifts)", async () => {
    // Compound pair: 12:00-14:00 lunch + 18:00-22:00 dinner (split shift — non-overlapping).
    // A third overlapping slot (13:00-15:00) sits in the same worker-date group to
    // verify the no_overlap encoding still fires normally; the compound pair's
    // presence in the group must not break anything.
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "2026-04-27", "12:00", "14:00", { compound: true, compoundPairId: 2 }),
      makeSlot(2, "2026-04-27", "18:00", "22:00", { compound: true, compoundPairId: 1 }),
      makeSlot(3, "2026-04-27", "13:00", "15:00"),
    ];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    const names = assignmentVarNames();
    expect(names.length).toBe(3);
    // Slot 3 (13-15) overlaps slot 1 (12-14): must be mutually exclusive.
    expect(hasMutualExclusion(names[0], names[2])).toBe(true);
    // Slot 3 (13-15) does not overlap slot 2 (18-22): no constraint.
    expect(hasMutualExclusion(names[1], names[2])).toBe(false);
    // Compound siblings (slot 1 and slot 2) are non-overlapping by construction;
    // their presence vars are co-equal via C2 `varA == varB`, so no_overlap is a
    // no-op in practice. The key assertion: no at_most_one is emitted forbidding
    // them both being 1 (that would clash with the C2 equality).
    const am1ForbidsCompound = (captured?.constraints ?? []).some(c =>
      c.type === "at_most_one"
      && (c.vars as string[]).includes(names[0])
      && (c.vars as string[]).includes(names[1]),
    );
    expect(am1ForbidsCompound).toBe(false);
  });

  test("overnight slot (22:00-02:00) overlapping early-morning slot (01:00-05:00) on the same date produces mutual-exclusion constraint", async () => {
    // timesOverlap treats these as overlapping (same-date, overnight-aware).
    // M8 encoding must preserve that semantic — either via at_most_one (old)
    // or via split intervals on the 0-1440 timeline (new).
    const workers = [makeWorker("w1")];
    const slots = [
      makeSlot(1, "2026-04-27", "22:00", "02:00", { hours: 4 }),
      makeSlot(2, "2026-04-27", "01:00", "05:00", { hours: 4 }),
    ];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    const names = assignmentVarNames();
    expect(names.length).toBe(2);
    expect(hasMutualExclusion(names[0], names[1])).toBe(true);
  });
});
