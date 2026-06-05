import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import {
  solveWithFallback,
  solverFns,
  __resetSolveEvents,
} from "./solver-fallback.js";
import {
  CPSATBadModelError,
  __resetCircuitState,
} from "./solver-circuit.js";

// Audit H5 regression: a 4xx from the CP-SAT sidecar means the model we built
// is malformed (our bug). The error MUST propagate past solveCPSAT,
// solveWithFallback, and the route layer — previously it was swallowed into a
// degraded result and the caller silently fell back to greedy.

const origFetch = globalThis.fetch;
const origCpsat = solverFns.cpsat;
const origIlp = solverFns.ilp;

const BAD_MODEL_DETAIL = "illegal coefficient on var x_0";

function stubBadModelFetch() {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url.endsWith("/solve")) {
      return new Response(BAD_MODEL_DETAIL, { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeWorker(id: string): ILPWorker {
  return {
    id,
    name: id,
    role: "kitchen",
    priority: 1,
    overtimeWilling: false,
    contractHours: 35,
    subRoles: ["Chef"],
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

function makeSlot(id: number): ILPSlot {
  return {
    id,
    date: "2026-04-27",
    dow: 1,
    zone: "A",
    role: "kitchen",
    startTime: "11:00",
    endTime: "15:00",
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

describe("Bad-model propagation (audit H5)", () => {
  beforeEach(() => {
    __resetCircuitState();
    __resetSolveEvents();
    solverFns.cpsat = origCpsat;
    solverFns.ilp = origIlp;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    solverFns.cpsat = origCpsat;
    solverFns.ilp = origIlp;
  });

  test("solveCPSAT throws CPSATBadModelError on 4xx from sidecar", async () => {
    stubBadModelFetch();
    const p = solveCPSAT(
      [makeWorker("w1")],
      [makeSlot(1)],
      makeConfig(),
      alwaysAvailable,
    );
    await expect(p).rejects.toBeInstanceOf(CPSATBadModelError);
    await expect(p).rejects.toMatchObject({ status: 400 });
  });

  test("solveWithFallback does NOT fall back to ILP on CPSATBadModelError", async () => {
    const err = new CPSATBadModelError(
      `CP-SAT bad model 400: ${BAD_MODEL_DETAIL}`,
      400,
    );
    solverFns.cpsat = async () => {
      throw err;
    };
    let ilpCalled = false;
    solverFns.ilp = async () => {
      ilpCalled = true;
      return {
        status: "optimal",
        assignments: [],
        solveTimeMs: 0,
        stats: { variables: 0, constraints: 0, workers: 0, slots: 0 },
      };
    };

    await expect(
      solveWithFallback([], [], {} as any, alwaysAvailable),
    ).rejects.toBe(err);
    expect(ilpCalled).toBe(false);
  });

  test("route-level onError returns 5xx with error detail in body", async () => {
    // Mirrors autostaffingRoutes.onError — mounting the full route module
    // would require stubbing auth + DB, so we exercise the handler directly
    // on a thin Hono app. Handler code lives at routes/autostaffing.ts and is
    // kept textually identical to the one under test.
    const app = new Hono();
    app.onError((err, c) => {
      return c.json({ error: err?.message || "autostaffing failed" }, 500);
    });
    app.post("/preview", () => {
      throw new CPSATBadModelError(
        `CP-SAT bad model 400: ${BAD_MODEL_DETAIL}`,
        400,
      );
    });

    const res = await app.request("/preview", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(BAD_MODEL_DETAIL);
  });
});
