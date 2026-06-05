import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, ILPResult, AvailabilityChecker, MultiWeekConfig } from "./ilp-solver.js";
import { solveILP } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { __resetCircuitState } from "./solver-circuit.js";
import { parityTestsEnabled } from "./solver-fallback.js";

// Cross-backend parity harness — ILP (HiGHS) vs CP-SAT on the dimensions
// both backends implement.
//
// ── Why this is off by default (audit restructure step D, 2026-04-24) ────
// ILP is feature-frozen per audit restructure step C, so the set of things
// the two backends *should* match on is bounded and shrinking. Running this
// by default risks failing the suite on an intentional parity gap (every
// new CP-SAT objective term is one). The suite still has real diagnostic
// value when explicitly auditing equivalence on the shared feature surface,
// so we keep it — just gated.
//
// ── How to enable ────────────────────────────────────────────────────────
// Run `SOLVER_PARITY_TESTS=1 bun test packages/api/src/utils/solver-parity.test.ts`.
// Also requires a live CP-SAT sidecar (packages/api/solver/start-solver.sh).
// Gate lives in `solver-fallback.ts` next to `solverDiagEnabled()` and
// `templateMatchEnabled()`; default OFF.
//
// Tolerance: identical filled-slot set (fill is the dominant objective), and
// per-worker total hours within 1h (breaks ties between equivalent workers).
//
// ── Intentional parity gaps (source of truth: solver-fallback.ts header) ─
// ILP is feature-frozen; these dimensions are deliberately NOT covered here
// because the backends are expected to diverge on them:
//   - `templateMatch` objective term — all fixtures set templateMatch=0 or
//     omit it. CP-SAT-only; ILP has no implementation.
//   - `hints` / AddHint warm-start — neither fixture passes hints. ILP
//     accepts and discards the argument.
//   - Determinism controls (CPSAT_RANDOM_SEED, CPSAT_NUM_WORKERS,
//     max_deterministic_time) — CP-SAT sidecar only.
//   - Structured infeasibility reasons and top-level `objectiveValue`.
// When adding a new CP-SAT-only feature, update `solver-fallback.ts`'s
// parity-gap block (the authoritative list) rather than duplicating here.

const describeOrSkip = parityTestsEnabled() ? describe : describe.skip;

// ── Tolerance ────────────────────────────────────────────────────────────
const PARITY_TOLERANCE = { hoursPerWorker: 1 };

function filledSlotIds(r: ILPResult): number[] {
  return Array.from(new Set(r.assignments.map(a => a.slotId))).sort((a, b) => a - b);
}

function workerHours(r: ILPResult, slots: ILPSlot[]): Map<string, number> {
  const slotHours = new Map<number, number>();
  for (const s of slots) slotHours.set(s.id, s.hours);
  const out = new Map<string, number>();
  for (const a of r.assignments) {
    const h = slotHours.get(a.slotId) ?? 0;
    out.set(a.workerId, (out.get(a.workerId) ?? 0) + h);
  }
  return out;
}

function assertParity(ilp: ILPResult, cpsat: ILPResult, slots: ILPSlot[]) {
  expect(cpsat.status).toBe(ilp.status);
  expect(filledSlotIds(cpsat)).toEqual(filledSlotIds(ilp));
  const ilpHours = workerHours(ilp, slots);
  const cpHours = workerHours(cpsat, slots);
  for (const [workerId, h] of ilpHours) {
    const cp = cpHours.get(workerId) ?? 0;
    expect(Math.abs(cp - h)).toBeLessThan(PARITY_TOLERANCE.hoursPerWorker);
  }
  // Workers that ILP gave zero hours should also be ≤tolerance on CP-SAT.
  for (const [workerId, cp] of cpHours) {
    if (!ilpHours.has(workerId)) {
      expect(cp).toBeLessThan(PARITY_TOLERANCE.hoursPerWorker);
    }
  }
}

// ── Factories ────────────────────────────────────────────────────────────

type WorkerOverrides = Partial<ILPWorker> & { id: string };
function makeWorker(o: WorkerOverrides): ILPWorker {
  return {
    name: o.id,
    role: "kitchen",
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
    ...o,
  };
}

type SlotOverrides = Partial<ILPSlot> & { id: number; date: string };
function makeSlot(o: SlotOverrides): ILPSlot {
  const startTime = o.startTime ?? "11:00";
  const endTime = o.endTime ?? "15:00";
  return {
    dow: new Date(o.date + "T12:00:00Z").getUTCDay(),
    zone: "A",
    role: "kitchen",
    startTime,
    endTime,
    hours: 4,
    target: 1,
    existingFill: 0,
    compound: false,
    ...o,
  };
}

function makeConfig(over: Partial<ILPConfig> = {}): ILPConfig {
  return {
    maxDailyHoursCompound: 11,
    minRestHours: 11,
    maxConsecutiveDays: 6,
    maxRollingWorkDays: 5,
    max12WeekAvgHours: 46,
    otCap: 43,
    disabledRules: new Set(),
    otDistribution: "even",
    dayPriorityMap: {},
    prefEnabled: false,
    templates: [],
    ...over,
  };
}

const alwaysAvailable: AvailabilityChecker = {
  isAvailable: () => true,
  prefersSlot: () => false,
};

async function solveBoth(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  multiWeek?: MultiWeekConfig,
): Promise<{ ilp: ILPResult; cpsat: ILPResult }> {
  const [ilp, cpsat] = await Promise.all([
    solveILP(workers, slots, config, alwaysAvailable, multiWeek),
    solveCPSAT(workers, slots, config, alwaysAvailable, multiWeek),
  ]);
  return { ilp, cpsat };
}

beforeEach(() => {
  __resetCircuitState();
});

afterEach(() => {
  __resetCircuitState();
});

// ─────────────────────────────────────────────────────────────────────────

describeOrSkip("solver parity — ILP vs CP-SAT", () => {
  test("fixture 1: trivial — 3 workers, 5 single-role slots, no OT", async () => {
    const workers = [
      makeWorker({ id: "w1", priority: 1 }),
      makeWorker({ id: "w2", priority: 2 }),
      makeWorker({ id: "w3", priority: 3 }),
    ];
    const slots = [
      makeSlot({ id: 1, date: "2026-04-27" }),
      makeSlot({ id: 2, date: "2026-04-28" }),
      makeSlot({ id: 3, date: "2026-04-29" }),
      makeSlot({ id: 4, date: "2026-04-30" }),
      makeSlot({ id: 5, date: "2026-05-01" }),
    ];
    const { ilp, cpsat } = await solveBoth(workers, slots, makeConfig());

    // All 5 slots should fill (20h ÷ 3 workers × 35h contract — plenty of room).
    expect(filledSlotIds(ilp).length).toBe(5);
    assertParity(ilp, cpsat, slots);
  });

  test("fixture 2: cost-sensitive — cheaper worker preferred when costAwareness is on", async () => {
    // Two identical-role workers with different hourly rates. With
    // costAwareness > 0, both backends must prefer the cheaper worker
    // (w1 @ €12/h) for all 3 slots. This test would have caught finding #1
    // (sign/scale divergence) before Phase 1 unified the formulation.
    const workers = [
      makeWorker({ id: "w1", priority: 1, hourlyRateCents: 1200 }),
      makeWorker({ id: "w2", priority: 1, hourlyRateCents: 1500 }),
    ];
    const slots = [
      makeSlot({ id: 1, date: "2026-04-27" }),
      makeSlot({ id: 2, date: "2026-04-28" }),
      makeSlot({ id: 3, date: "2026-04-29" }),
    ];
    const weights = { fill: 1000, bucket0Value: 300, bucket1Value: 5, bucket2Penalty: 150, bucket3Penalty: 500, bucket2OtOffset: 0.7, bucket3OtOffset: 0.5, consistency: 5, preference: 3, priority: 0, flexibility: 0, subroleMismatch: 800, rolePenalty: 500, costAwareness: 4, leaveConservation: 0, redundancy: 0, templateMatch: 0, contractCompletion: 0, titulaireBonus: 0 };

    const [ilp, cpsat] = await Promise.all([
      solveILP(workers, slots, makeConfig(), alwaysAvailable, undefined, undefined, weights),
      solveCPSAT(workers, slots, makeConfig(), alwaysAvailable, undefined, undefined, weights),
    ]);

    assertParity(ilp, cpsat, slots);
    // Both backends should concentrate work on the cheaper worker when priority is neutral.
    const ilpHours = workerHours(ilp, slots);
    const cpHours = workerHours(cpsat, slots);
    expect((ilpHours.get("w1") ?? 0)).toBeGreaterThanOrEqual(ilpHours.get("w2") ?? 0);
    expect((cpHours.get("w1") ?? 0)).toBeGreaterThanOrEqual(cpHours.get("w2") ?? 0);
  });

  test("fixture 3: role-breakdown — two same-day services each need 1 Chef", async () => {
    // Same date/zone, two kitchen services, each needs 1 Chef. CP-SAT must
    // emit a role-breakdown soft constraint on BOTH slots (pre-Phase-2 it
    // only emitted for the first of the group).
    const workers = [
      makeWorker({ id: "w1", subRoles: ["Chef"] }),
      makeWorker({ id: "w2", subRoles: ["Chef"] }),
      makeWorker({ id: "w3", subRoles: ["Cuisinier"] }),
      makeWorker({ id: "w4", subRoles: ["Cuisinier"] }),
    ];
    const slots = [
      makeSlot({ id: 1, date: "2026-04-27", startTime: "11:00", endTime: "15:00", target: 2, roleBreakdown: { Chef: 1 } }),
      makeSlot({ id: 2, date: "2026-04-27", startTime: "18:00", endTime: "22:00", target: 2, roleBreakdown: { Chef: 1 } }),
    ];
    const { ilp, cpsat } = await solveBoth(workers, slots, makeConfig());

    assertParity(ilp, cpsat, slots);
    // Sanity: both slots should have a Chef assigned in each backend.
    for (const r of [ilp, cpsat]) {
      for (const slot of slots) {
        const chefsOnSlot = r.assignments
          .filter(a => a.slotId === slot.id)
          .filter(a => workers.find(w => w.id === a.workerId)?.subRoles.includes("Chef"));
        expect(chefsOnSlot.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("fixture 4: multi-week with accrued historical hours", async () => {
    // 2-week horizon. One worker starts with historicalHours > 0 (past weeks
    // already count toward C9 rolling average). Both backends must treat the
    // same arrays identically. Pre-Phase-4, CP-SAT could `?? 0` an undersized
    // array silently.
    const workers = [
      makeWorker({ id: "w1", priority: 1, historicalHours: 70, historicalWeeks: 2 }),
      makeWorker({ id: "w2", priority: 2, historicalHours: 40, historicalWeeks: 2 }),
    ];
    const slots = [
      makeSlot({ id: 1, date: "2026-04-27", week: 0 }),
      makeSlot({ id: 2, date: "2026-04-28", week: 0 }),
      makeSlot({ id: 3, date: "2026-05-04", week: 1 }),
      makeSlot({ id: 4, date: "2026-05-05", week: 1 }),
    ];
    const numWeeks = 2;
    const multiWeek: MultiWeekConfig = {
      numWeeks,
      existingHoursByWeek: new Map([
        ["w1", new Array(numWeeks).fill(0)],
        ["w2", new Array(numWeeks).fill(0)],
      ]),
      c9BaseHours: new Map([
        ["w1", new Array(numWeeks).fill(35)],
        ["w2", new Array(numWeeks).fill(20)],
      ]),
      c9BaseWeeks: new Map([
        ["w1", new Array(numWeeks).fill(2)],
        ["w2", new Array(numWeeks).fill(2)],
      ]),
    };

    const { ilp, cpsat } = await solveBoth(workers, slots, makeConfig(), multiWeek);
    assertParity(ilp, cpsat, slots);
  });

  test("fixture 4b: multi-week low-confidence C9 — gate widens, both backends honor", async () => {
    // historicalWeeks=4 → c9ConfidenceFromWeekCount → "low" → decision.apply=true
    // with capMultiplier=1.10. Pre-Phase-4b: CP-SAT honors the gate and emits
    // C9; ILP still re-gates on `historicalWeeks < 6` (and `c9BaseWeeks[wk]+wk<6`)
    // and silently skips → the widened cap never binds on ILP and the backends
    // disagree on w1's total hours.
    //
    // Tuning: maxTotal = 46h × 12 × 1.10 = 607.2h. c9BaseHours=565 →
    // remaining=42.2h across the rolling window. Slot hours=8 so w1 can fill
    // at most 5 eight-hour slots (40h) over the two planning weeks before the
    // constraint binds at wk=1 (which sums wk=0+wk=1 vars). CostAwareness +
    // hourly-rate gap pushes both backends to pack w1 in the no-C9
    // counterfactual, so C9 must actively redistribute to w2 in the fix case.
    const workers = [
      makeWorker({ id: "w1", priority: 1, contractHours: 35, overtimeWilling: true,
                   historicalHours: 565, historicalWeeks: 4, hourlyRateCents: 500 }),
      makeWorker({ id: "w2", priority: 2, contractHours: 35, historicalWeeks: 4,
                   hourlyRateCents: 5000 }),
    ];
    const numWeeks = 2;
    const slots: ILPSlot[] = [];
    let id = 1;
    for (let wk = 0; wk < numWeeks; wk++) {
      for (let d = 0; d < 5; d++) {
        const day = new Date("2026-04-27T12:00:00Z");
        day.setUTCDate(day.getUTCDate() + wk * 7 + d);
        slots.push(makeSlot({
          id: id++,
          date: day.toISOString().slice(0, 10),
          week: wk,
          startTime: "11:00",
          endTime: "19:00",
          hours: 8,
        }));
      }
    }
    const multiWeek: MultiWeekConfig = {
      numWeeks,
      existingHoursByWeek: new Map([
        ["w1", new Array(numWeeks).fill(0)],
        ["w2", new Array(numWeeks).fill(0)],
      ]),
      c9BaseHours: new Map([
        ["w1", new Array(numWeeks).fill(565)],
        ["w2", new Array(numWeeks).fill(0)],
      ]),
      c9BaseWeeks: new Map([
        ["w1", new Array(numWeeks).fill(4)],
        ["w2", new Array(numWeeks).fill(4)],
      ]),
    };
    const weights = { fill: 1000, bucket0Value: 300, bucket1Value: 5, bucket2Penalty: 150, bucket3Penalty: 500, bucket2OtOffset: 0.7, bucket3OtOffset: 0.5, consistency: 5, preference: 3, priority: 0, flexibility: 0, subroleMismatch: 800, rolePenalty: 500, costAwareness: 10, leaveConservation: 0, redundancy: 0, templateMatch: 0, contractCompletion: 0, titulaireBonus: 0 };

    const [ilp, cpsat] = await Promise.all([
      solveILP(workers, slots, makeConfig(), alwaysAvailable, multiWeek, undefined, weights),
      solveCPSAT(workers, slots, makeConfig(), alwaysAvailable, multiWeek, undefined, weights),
    ]);

    // Multiple optima exist (any 5 of 10 slots filled on w1 is equivalent under
    // the widened cap), so compare the SHAPE rather than exact slot ids: status,
    // fill count, and per-worker hours within tolerance.
    expect(cpsat.status).toBe(ilp.status);
    expect(filledSlotIds(cpsat).length).toBe(filledSlotIds(ilp).length);
    const ilpHours = workerHours(ilp, slots);
    const cpHours = workerHours(cpsat, slots);
    for (const id of new Set([...ilpHours.keys(), ...cpHours.keys()])) {
      const h1 = ilpHours.get(id) ?? 0;
      const h2 = cpHours.get(id) ?? 0;
      expect(Math.abs(h1 - h2)).toBeLessThan(PARITY_TOLERANCE.hoursPerWorker);
    }
    // Sanity: the widened cap must actively bind. w1 cannot exceed 42.2h across
    // the rolling window, so at most 5 eight-hour slots (40h). If either backend
    // gives w1 ≥48h the cap isn't biting and the fixture doesn't prove anything.
    expect(cpHours.get("w1") ?? 0).toBeLessThanOrEqual(40);
    expect(ilpHours.get("w1") ?? 0).toBeLessThanOrEqual(40);
  });

  test("fixture 5: cross-week C7 — 7 consecutive days must bind", async () => {
    // 7 consecutive days spanning the wk0→wk1 boundary. C7 caps at 6 → at
    // least one slot must be left unfilled in both backends. Tests that C7
    // indicators span week boundaries (finding #3 verification).
    //   wk0: Wed..Sun (2026-04-29 → 2026-05-03)
    //   wk1: Mon..Tue (2026-05-04, 2026-05-05)
    const worker = makeWorker({ id: "w1", priority: 1 });
    const dates: Array<{ date: string; week: number }> = [
      { date: "2026-04-29", week: 0 },
      { date: "2026-04-30", week: 0 },
      { date: "2026-05-01", week: 0 },
      { date: "2026-05-02", week: 0 },
      { date: "2026-05-03", week: 0 },
      { date: "2026-05-04", week: 1 },
      { date: "2026-05-05", week: 1 },
    ];
    const slots = dates.map((d, i) => makeSlot({ id: i + 1, date: d.date, week: d.week }));
    const numWeeks = 2;
    const multiWeek: MultiWeekConfig = {
      numWeeks,
      existingHoursByWeek: new Map([[worker.id, new Array(numWeeks).fill(0)]]),
      c9BaseHours: new Map([[worker.id, new Array(numWeeks).fill(0)]]),
      c9BaseWeeks: new Map([[worker.id, new Array(numWeeks).fill(0)]]),
    };
    const { ilp, cpsat } = await solveBoth([worker], slots, makeConfig(), multiWeek);

    // C7 must bind: can't work 7 consecutive days. ≥1 slot unfilled in both.
    // Multiple optima exist (any ≤6-day consecutive subset is valid), so
    // compare the SHAPE rather than exact slot ids: same status, same number
    // of filled slots, and the single worker's total hours within tolerance.
    expect(cpsat.status).toBe(ilp.status);
    expect(filledSlotIds(ilp).length).toBeLessThanOrEqual(6);
    expect(filledSlotIds(cpsat).length).toBe(filledSlotIds(ilp).length);
    const ilpHours = workerHours(ilp, slots).get(worker.id) ?? 0;
    const cpHours = workerHours(cpsat, slots).get(worker.id) ?? 0;
    expect(Math.abs(cpHours - ilpHours)).toBeLessThan(PARITY_TOLERANCE.hoursPerWorker);
  });
});
