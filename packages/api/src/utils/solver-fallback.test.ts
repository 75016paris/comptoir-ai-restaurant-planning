import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  solveWithFallback,
  solverFns,
  solverDiagEnabled,
  parityTestsEnabled,
  getFallbackRate7d,
  __resetSolveEvents,
} from "./solver-fallback.js";
import { CPSATUnreachableError } from "./solver-circuit.js";
import type { ILPResult } from "./ilp-solver.js";

// Minimal inputs — the stub solvers ignore them.
const inputs: [any, any, any, any] = [
  [],
  [],
  {} as any,
  { isAvailable: () => false, prefersSlot: () => false } as any,
];

function fakeResult(overrides: Partial<ILPResult> = {}): ILPResult {
  return {
    status: "optimal",
    assignments: [],
    solveTimeMs: 1,
    stats: { variables: 0, constraints: 0, workers: 0, slots: 0 },
    ...overrides,
  };
}

const origCpsat = solverFns.cpsat;
const origIlp = solverFns.ilp;

beforeEach(() => {
  __resetSolveEvents();
  solverFns.cpsat = origCpsat;
  solverFns.ilp = origIlp;
});

afterEach(() => {
  solverFns.cpsat = origCpsat;
  solverFns.ilp = origIlp;
});

describe("solveWithFallback", () => {
  test("returns CP-SAT result when solver is healthy", async () => {
    solverFns.cpsat = async () => fakeResult({ status: "optimal" });
    solverFns.ilp = async () => {
      throw new Error("ILP should not be called");
    };
    const res = await solveWithFallback(inputs[0], inputs[1], inputs[2], inputs[3]);
    expect(res.status).toBe("optimal");
    expect(res.solverUsed).toBe("cpsat");
  });

  test("falls back to ILP on CPSATUnreachableError", async () => {
    solverFns.cpsat = async () => {
      throw new CPSATUnreachableError("sidecar down");
    };
    let ilpCalled = false;
    solverFns.ilp = async () => {
      ilpCalled = true;
      return fakeResult({ status: "feasible" });
    };
    const res = await solveWithFallback(inputs[0], inputs[1], inputs[2], inputs[3]);
    expect(ilpCalled).toBe(true);
    expect(res.status).toBe("feasible");
    expect(res.solverUsed).toBe("ilp-fallback");
  });

  test("does not fall back on non-unreachable errors (e.g. bad-model)", async () => {
    const err = new Error("bad input");
    solverFns.cpsat = async () => { throw err; };
    solverFns.ilp = async () => fakeResult();
    await expect(solveWithFallback(inputs[0], inputs[1], inputs[2], inputs[3])).rejects.toBe(err);
  });

  test("records fallback rate over the 7-day window", async () => {
    // 1 CP-SAT success + 1 fallback → fallback rate 0.5
    solverFns.cpsat = async () => fakeResult();
    solverFns.ilp = async () => fakeResult();
    await solveWithFallback(inputs[0], inputs[1], inputs[2], inputs[3]);

    solverFns.cpsat = async () => { throw new CPSATUnreachableError("flap"); };
    await solveWithFallback(inputs[0], inputs[1], inputs[2], inputs[3]);

    expect(getFallbackRate7d()).toBeCloseTo(0.5, 5);
  });

  test("SOLVER_FALLBACK_ENABLED=0 propagates the unreachable error", async () => {
    const prev = process.env.SOLVER_FALLBACK_ENABLED;
    process.env.SOLVER_FALLBACK_ENABLED = "0";
    try {
      solverFns.cpsat = async () => { throw new CPSATUnreachableError("down"); };
      solverFns.ilp = async () => fakeResult();
      await expect(solveWithFallback(inputs[0], inputs[1], inputs[2], inputs[3])).rejects.toBeInstanceOf(CPSATUnreachableError);
    } finally {
      if (prev === undefined) delete process.env.SOLVER_FALLBACK_ENABLED;
      else process.env.SOLVER_FALLBACK_ENABLED = prev;
    }
  });
});

describe("solverDiagEnabled", () => {
  // Matrix mirrors templateMatchEnabled in dow-template.test.ts. Both helpers
  // use the same "1" || "true" contract, so they should reject the same
  // unknown truthy strings ("yes") for predictability.
  const original = process.env.SOLVER_DIAG;

  afterEach(() => {
    if (original === undefined) delete process.env.SOLVER_DIAG;
    else process.env.SOLVER_DIAG = original;
  });

  test("unset → off (default production behaviour)", () => {
    delete process.env.SOLVER_DIAG;
    expect(solverDiagEnabled()).toBe(false);
  });

  test('"1" → on', () => {
    process.env.SOLVER_DIAG = "1";
    expect(solverDiagEnabled()).toBe(true);
  });

  test('"true" → on', () => {
    process.env.SOLVER_DIAG = "true";
    expect(solverDiagEnabled()).toBe(true);
  });

  test('"0" / "" / "false" / "yes" → off', () => {
    process.env.SOLVER_DIAG = "0";
    expect(solverDiagEnabled()).toBe(false);
    process.env.SOLVER_DIAG = "";
    expect(solverDiagEnabled()).toBe(false);
    process.env.SOLVER_DIAG = "false";
    expect(solverDiagEnabled()).toBe(false);
    process.env.SOLVER_DIAG = "yes";
    expect(solverDiagEnabled()).toBe(false);
  });
});

describe("parityTestsEnabled", () => {
  // Matrix mirrors solverDiagEnabled / templateMatchEnabled — same contract,
  // same rejected unknown-truthy strings. Keeps the three gates predictable.
  const original = process.env.SOLVER_PARITY_TESTS;

  afterEach(() => {
    if (original === undefined) delete process.env.SOLVER_PARITY_TESTS;
    else process.env.SOLVER_PARITY_TESTS = original;
  });

  test("unset → off (default suite behaviour)", () => {
    delete process.env.SOLVER_PARITY_TESTS;
    expect(parityTestsEnabled()).toBe(false);
  });

  test('"1" → on', () => {
    process.env.SOLVER_PARITY_TESTS = "1";
    expect(parityTestsEnabled()).toBe(true);
  });

  test('"true" → on', () => {
    process.env.SOLVER_PARITY_TESTS = "true";
    expect(parityTestsEnabled()).toBe(true);
  });

  test('"0" / "" / "false" / "yes" → off', () => {
    process.env.SOLVER_PARITY_TESTS = "0";
    expect(parityTestsEnabled()).toBe(false);
    process.env.SOLVER_PARITY_TESTS = "";
    expect(parityTestsEnabled()).toBe(false);
    process.env.SOLVER_PARITY_TESTS = "false";
    expect(parityTestsEnabled()).toBe(false);
    process.env.SOLVER_PARITY_TESTS = "yes";
    expect(parityTestsEnabled()).toBe(false);
  });
});
