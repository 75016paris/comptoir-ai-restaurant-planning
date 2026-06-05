import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";

// Audit M7: pin that symmetry-breaking lex constraints fire on interchangeable
// workers and stay silent otherwise. Shape check only — end-to-end search
// savings require a live sidecar and are covered by the calibration harness.
// The encoding is used-monotone implication: for each symmetry class of size
// ≥ 2, introduce `u_*` bool indicators and emit adjacent-pair linear
// `u_i - u_{i+1} >= 0` constraints. This test filters captured constraints to
// those with exactly two `u_*` terms and (+1, -1) coeffs — the exact lex-leader
// signature, which doesn't collide with the channelling linears (those have one
// `u_*` term and one or more `x_*` terms).

const origFetch = globalThis.fetch;
const origSym = process.env.CPSAT_SYMMETRY_BREAK;

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

function makeSlot(id: number, date: string, startTime: string, endTime: string): ILPSlot {
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

// A lex-leader constraint has the exact shape
//   { type:"linear", terms:[{var:u_X,coeff:1},{var:u_Y,coeff:-1}], op:">=", rhs:0 }
// with both term vars starting with `u_`. This is distinct from the channelling
// linears (one u_* term plus x_* terms, or a u vs sum of x_* terms).
function lexConstraints(): Array<Record<string, unknown>> {
  if (!captured) return [];
  return captured.constraints.filter(c => {
    if (c.type !== "linear") return false;
    const terms = c.terms as Array<{ var: string; coeff: number }> | undefined;
    if (!terms || terms.length !== 2) return false;
    if (c.op !== ">=" || c.rhs !== 0) return false;
    const [a, b] = terms;
    if (!a.var.startsWith("u_") || !b.var.startsWith("u_")) return false;
    return a.coeff === 1 && b.coeff === -1;
  });
}

beforeEach(() => {
  __resetCircuitState();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origSym === undefined) delete process.env.CPSAT_SYMMETRY_BREAK;
  else process.env.CPSAT_SYMMETRY_BREAK = origSym;
});

describe("cpsat-solver emits symmetry-breaking lex constraints on interchangeable workers (audit M7)", () => {
  test("two perfectly-interchangeable workers produce one adjacent lex constraint", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slots = [makeSlot(1, "2026-04-27", "11:00", "15:00"), makeSlot(2, "2026-04-28", "11:00", "15:00")];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    const lex = lexConstraints();
    expect(lex.length).toBe(1);
    // Two u_* indicator bools were registered
    const uVars = captured!.variables.filter(v => v.name.startsWith("u_") && v.type === "bool");
    expect(uVars.length).toBe(2);
  });

  test("workers differing in subRoles produce no symmetry constraints", async () => {
    const workers = [makeWorker("w1", { subRoles: ["Chef"] }), makeWorker("w2", { subRoles: ["Sous-chef"] })];
    const slots = [makeSlot(1, "2026-04-27", "11:00", "15:00")];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    expect(lexConstraints().length).toBe(0);
  });

  test("workers with same fields but different availability produce no symmetry constraints", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slots = [makeSlot(1, "2026-04-27", "11:00", "15:00"), makeSlot(2, "2026-04-28", "11:00", "15:00")];
    const checker: AvailabilityChecker = {
      // w1 is available everywhere; w2 is unavailable on slot 2
      isAvailable: (workerId, s) => !(workerId === "w2" && s.id === 2),
      prefersSlot: () => false,
    };
    await solveCPSAT(workers, slots, makeConfig(), checker);
    expect(lexConstraints().length).toBe(0);
  });

  test("three interchangeable workers produce two adjacent-pair lex constraints (not three pairwise)", async () => {
    const workers = [makeWorker("w1"), makeWorker("w2"), makeWorker("w3")];
    const slots = [makeSlot(1, "2026-04-27", "11:00", "15:00"), makeSlot(2, "2026-04-28", "11:00", "15:00")];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    expect(lexConstraints().length).toBe(2);
    const uVars = captured!.variables.filter(v => v.name.startsWith("u_") && v.type === "bool");
    expect(uVars.length).toBe(3);
  });

  test("CPSAT_SYMMETRY_BREAK=0 disables emission entirely", async () => {
    process.env.CPSAT_SYMMETRY_BREAK = "0";
    const workers = [makeWorker("w1"), makeWorker("w2")];
    const slots = [makeSlot(1, "2026-04-27", "11:00", "15:00"), makeSlot(2, "2026-04-28", "11:00", "15:00")];
    await solveCPSAT(workers, slots, makeConfig(), alwaysAvailable);
    expect(lexConstraints().length).toBe(0);
    const uVars = captured!.variables.filter(v => v.name.startsWith("u_") && v.type === "bool");
    expect(uVars.length).toBe(0);
  });
});
