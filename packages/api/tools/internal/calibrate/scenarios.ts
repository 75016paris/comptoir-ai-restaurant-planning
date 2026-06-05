// Adversarial scenario generator.
//
// Each scenario takes a SyntheticRestaurant + base Monday and produces solver inputs
// (workers, slots, multiWeek config, checker) representing a stress condition.

import type { ILPWorker, ILPSlot, AvailabilityChecker, MultiWeekConfig } from "../../../src/utils/ilp-solver.js";
import type { SyntheticRestaurant } from "./generate.js";
import { expandWeekTemplate } from "./generate.js";
import { makeRng, pick } from "./prng.js";

export const SCENARIOS = ["clean", "holiday-cluster", "restriction-surge", "demand-spike", "c9-binding"] as const;
export type ScenarioName = typeof SCENARIOS[number];

export interface SolveInputs {
  workers: ILPWorker[];
  slots: ILPSlot[];
  multiWeek?: MultiWeekConfig;
  checker: AvailabilityChecker;
  // Theoretical max fillable hours (slots × target × hours, accounting for blocked workers).
  // Used by metrics to normalize fill rate against feasibility, not against 100%.
  totalDemandHours: number;
  totalCapacityHours: number;
}

// Default horizon; overridable via setScenarioWeeks() from the harness (--weeks CLI flag).
// 4 weeks is the cheap smoke-test default; 12 weeks is what production solves against C9 (46h/12wk avg).
let NUM_WEEKS = 4;
const BASE_MONDAY = "2026-04-20";

export function setScenarioWeeks(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 52) throw new Error(`invalid horizon ${n}, want 1..52`);
  NUM_WEEKS = n;
}

// ── Deep-clone helpers (workers contain Maps + Sets) ──

function cloneWorker(w: ILPWorker): ILPWorker {
  return {
    ...w,
    subRoles: [...w.subRoles],
    existingWorkDates: new Set(w.existingWorkDates),
    existingDailyHours: new Map(w.existingDailyHours),
    existingLastEnd: new Map(w.existingLastEnd),
    existingFirstStart: new Map(w.existingFirstStart),
    existingServicesByDate: new Map(w.existingServicesByDate),
    consistency: new Map(w.consistency),
  };
}

// ── Scenario builders ──

function buildClean(r: SyntheticRestaurant, scenarioSeed: number): SolveInputs {
  void scenarioSeed; // Clean is deterministic.
  const workers = r.workers.map(cloneWorker);
  const { slots, multiWeek } = expandWeekTemplate(r.weekTemplate, BASE_MONDAY, NUM_WEEKS);
  return {
    workers, slots, multiWeek, checker: r.checker,
    totalDemandHours: slots.reduce((s, sl) => s + sl.hours * sl.target, 0),
    totalCapacityHours: workers.reduce((s, w) => s + w.contractHours * NUM_WEEKS, 0),
  };
}

function buildHolidayCluster(r: SyntheticRestaurant, scenarioSeed: number): SolveInputs {
  // 15% of team unavailable for entire planning horizon (vacation).
  const rng = makeRng(scenarioSeed);
  const onLeave = new Set<string>();
  const targetCount = Math.max(1, Math.round(r.workers.length * 0.15));
  while (onLeave.size < targetCount) onLeave.add(pick(rng, r.workers).id);

  const workers = r.workers.map(cloneWorker);
  const { slots, multiWeek } = expandWeekTemplate(r.weekTemplate, BASE_MONDAY, NUM_WEEKS);

  // Wrap checker: workers on leave become unavailable for everything in the horizon.
  const checker: AvailabilityChecker = {
    isAvailable(workerId, slot) {
      if (onLeave.has(workerId)) return false;
      return r.checker.isAvailable(workerId, slot);
    },
    prefersSlot: r.checker.prefersSlot.bind(r.checker),
  };

  // Effective capacity drops by the on-leave workers' contracts.
  const effectiveCapacity = workers.filter(w => !onLeave.has(w.id))
    .reduce((s, w) => s + w.contractHours * NUM_WEEKS, 0);
  return {
    workers, slots, multiWeek, checker,
    totalDemandHours: slots.reduce((s, sl) => s + sl.hours * sl.target, 0),
    totalCapacityHours: effectiveCapacity,
  };
}

function buildRestrictionSurge(r: SyntheticRestaurant, scenarioSeed: number): SolveInputs {
  // Half the team gets 3-5 extra restrictions in addition to existing ones.
  const rng = makeRng(scenarioSeed);
  const newRestrictions = new Map<string, Set<string>>();
  for (const w of r.workers) newRestrictions.set(w.id, new Set(r.restrictions.get(w.id) ?? []));

  const dowZones = new Set<string>();
  for (const t of r.weekTemplate) dowZones.add(`${t.dow}_${t.zone}`);
  const dowZoneList = [...dowZones];

  const targetCount = Math.max(1, Math.round(r.workers.length * 0.5));
  const surge = new Set<string>();
  while (surge.size < targetCount) surge.add(pick(rng, r.workers).id);
  for (const wid of surge) {
    const set = newRestrictions.get(wid)!;
    const n = Math.floor(rng() * 3) + 3;
    for (let i = 0; i < n; i++) set.add(pick(rng, dowZoneList));
  }

  const checker: AvailabilityChecker = {
    isAvailable(workerId, slot) {
      const r2 = newRestrictions.get(workerId);
      if (r2?.has(`${slot.dow}_${slot.zone}`)) return false;
      return true;
    },
    prefersSlot: r.checker.prefersSlot.bind(r.checker),
  };

  const workers = r.workers.map(cloneWorker);
  const { slots, multiWeek } = expandWeekTemplate(r.weekTemplate, BASE_MONDAY, NUM_WEEKS);
  return {
    workers, slots, multiWeek, checker,
    totalDemandHours: slots.reduce((s, sl) => s + sl.hours * sl.target, 0),
    totalCapacityHours: workers.reduce((s, w) => s + w.contractHours * NUM_WEEKS, 0),
  };
}

function buildDemandSpike(r: SyntheticRestaurant, scenarioSeed: number): SolveInputs {
  void scenarioSeed;
  const workers = r.workers.map(cloneWorker);
  // Bump targets +20%.
  const bumpedTemplate = r.weekTemplate.map(t => ({
    ...t,
    target: Math.max(1, Math.ceil(t.target * 1.2)),
  }));
  const { slots, multiWeek } = expandWeekTemplate(bumpedTemplate, BASE_MONDAY, NUM_WEEKS);
  return {
    workers, slots, multiWeek, checker: r.checker,
    totalDemandHours: slots.reduce((s, sl) => s + sl.hours * sl.target, 0),
    totalCapacityHours: workers.reduce((s, w) => s + w.contractHours * NUM_WEEKS, 0),
  };
}

function buildC9Binding(r: SyntheticRestaurant, scenarioSeed: number): SolveInputs {
  // Inject 11 weeks of historical hours so that C9 (46h/week 12-week avg) binds tightly.
  // Each historical week = ~45h per worker, leaving very little C9 headroom.
  void scenarioSeed;
  const workers = r.workers.map(cloneWorker);
  const { slots, multiWeek: baseMW } = expandWeekTemplate(r.weekTemplate, BASE_MONDAY, NUM_WEEKS);

  if (baseMW) {
    for (const w of workers) {
      const baseHours: number[] = [];
      const baseWeeks: number[] = [];
      // For each planning week, count the historical weeks before it (within the 12-week window).
      // Planning week k is at history-position 12-numWeeks+k from the start of the 12-week window.
      for (let k = 0; k < NUM_WEEKS; k++) {
        const numHist = Math.max(0, 11 - k);
        baseHours.push(45 * numHist);
        baseWeeks.push(numHist);
      }
      baseMW.c9BaseHours.set(w.id, baseHours);
      baseMW.c9BaseWeeks.set(w.id, baseWeeks);
    }
  }

  return {
    workers, slots, multiWeek: baseMW, checker: r.checker,
    totalDemandHours: slots.reduce((s, sl) => s + sl.hours * sl.target, 0),
    totalCapacityHours: workers.reduce((s, w) => s + w.contractHours * NUM_WEEKS, 0),
  };
}

// ── Main entry ──

export function buildScenario(r: SyntheticRestaurant, scenario: ScenarioName, salt = 0): SolveInputs {
  const seed = (r.cfg.seed * 31 + salt + scenario.length) >>> 0;
  switch (scenario) {
    case "clean": return buildClean(r, seed);
    case "holiday-cluster": return buildHolidayCluster(r, seed);
    case "restriction-surge": return buildRestrictionSurge(r, seed);
    case "demand-spike": return buildDemandSpike(r, seed);
    case "c9-binding": return buildC9Binding(r, seed);
  }
}
