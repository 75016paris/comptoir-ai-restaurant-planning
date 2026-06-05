import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ILPWorker, ILPSlot, ILPConfig, AvailabilityChecker } from "./ilp-solver.js";
import { titulaireKey } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { DEFAULT_WEIGHTS, type WeightConfig } from "@comptoir/shared";
import { __resetCircuitState } from "./solver-circuit.js";

// titulaireBonus: when weights.titulaireBonus > 0 and config.preferredAssignmentKeys
// contains `${workerId}_${dow}_${zone}_${role}`, the per-(worker, slot) objective
// coefficient picks up an additional +titulaireBonus × SCALE bump. The bonus is
// per-slot — the same worker on a non-pinned slot gets nothing.

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
    flexibility: 0,
  };
}

function makeSlot(id: number, date: string, zone = "floor"): ILPSlot {
  return {
    id,
    date,
    dow: new Date(date + "T12:00:00Z").getUTCDay(),
    zone,
    role: "floor" as any,
    startTime: "11:00",
    endTime: "15:00",
    hours: 4,
    target: 2,
    existingFill: 0,
    compound: false,
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
    otDistribution: "equal",
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

function minimalWeights(over: Partial<WeightConfig> = {}): WeightConfig {
  return {
    ...DEFAULT_WEIGHTS,
    fill: 1000,
    consistency: 0,
    preference: 0,
    priority: 0,
    flexibility: 0,
    subroleMismatch: 0,
    rolePenalty: 0,
    costAwareness: 0,
    leaveConservation: 0,
    redundancy: 0,
    templateMatch: 0,
    contractCompletion: 0,
    titulaireBonus: 0,
    ...over,
  };
}

function findVarByName(req: any, name: string): { name: string; coeff: number } {
  const term = (req.objective.terms as any[]).find(t => t.var === name);
  if (!term) throw new Error(`no objective term for ${name}`);
  return term;
}

beforeEach(() => {
  __resetCircuitState();
  capturedRequest = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("cpsat-solver titulaireBonus per-slot key", () => {
  test("bonus + exact key match → coeff gains titulaireBonus × SCALE", async () => {
    const w1 = makeWorker("w1"); // pinned to (Tuesday, salle, salle)
    const w2 = makeWorker("w2"); // not pinned
    const slot = makeSlot(1, "2026-04-28"); // dow=2 Tuesday
    const config = makeConfig({
      preferredAssignmentKeys: new Set([titulaireKey("w1", slot.dow, "floor", "floor")]),
    });
    const weights = minimalWeights({ titulaireBonus: 80 });

    await solveCPSAT([w1, w2], [slot], config, alwaysAvailable, undefined, undefined, weights);

    const bools = (capturedRequest.variables as any[]).filter(v => v.type === "bool" && v.name.startsWith("x_"));
    const tW1 = findVarByName(capturedRequest, bools[0].name);
    const tW2 = findVarByName(capturedRequest, bools[1].name);

    expect(tW2.coeff).toBe(Math.round(1000 * SCALE));
    expect(tW1.coeff).toBe(Math.round((1000 + 80) * SCALE));
    expect(tW1.coeff - tW2.coeff).toBe(80 * SCALE);
  });

  test("worker pinned but on a different dow → no bonus on this slot", async () => {
    const w1 = makeWorker("w1");
    const slot = makeSlot(1, "2026-04-28"); // dow=2
    const config = makeConfig({
      preferredAssignmentKeys: new Set([titulaireKey("w1", 4, "floor", "floor")]), // dow=4 instead
    });
    const weights = minimalWeights({ titulaireBonus: 80 });

    await solveCPSAT([w1], [slot], config, alwaysAvailable, undefined, undefined, weights);

    const bools = (capturedRequest.variables as any[]).filter(v => v.type === "bool" && v.name.startsWith("x_"));
    const t = findVarByName(capturedRequest, bools[0].name);
    expect(t.coeff).toBe(Math.round(1000 * SCALE));
  });

  test("worker pinned but on a different zone → no bonus", async () => {
    const w1 = makeWorker("w1");
    const slot = makeSlot(1, "2026-04-28", "Soir");
    const config = makeConfig({
      preferredAssignmentKeys: new Set([titulaireKey("w1", slot.dow, "Midi", "floor")]),
    });
    const weights = minimalWeights({ titulaireBonus: 80 });

    await solveCPSAT([w1], [slot], config, alwaysAvailable, undefined, undefined, weights);

    const bools = (capturedRequest.variables as any[]).filter(v => v.type === "bool" && v.name.startsWith("x_"));
    expect(findVarByName(capturedRequest, bools[0].name).coeff).toBe(Math.round(1000 * SCALE));
  });

  test("bonus = 0 + exact key match → no extra coefficient", async () => {
    const w1 = makeWorker("w1");
    const slot = makeSlot(1, "2026-04-28");
    const config = makeConfig({
      preferredAssignmentKeys: new Set([titulaireKey("w1", slot.dow, "floor", "floor")]),
    });
    const weights = minimalWeights({ titulaireBonus: 0 });

    await solveCPSAT([w1], [slot], config, alwaysAvailable, undefined, undefined, weights);

    const bools = (capturedRequest.variables as any[]).filter(v => v.type === "bool" && v.name.startsWith("x_"));
    expect(findVarByName(capturedRequest, bools[0].name).coeff).toBe(Math.round(1000 * SCALE));
  });

  test("multi-day pin: bonus fires on each pinned (dow, zone, role) of the same worker", async () => {
    const w1 = makeWorker("w1");
    const slotMon = makeSlot(1, "2026-04-27"); // dow=1 Monday
    const slotTue = makeSlot(2, "2026-04-28"); // dow=2 Tuesday
    const slotWed = makeSlot(3, "2026-04-29"); // dow=3 Wednesday — NOT pinned
    const config = makeConfig({
      preferredAssignmentKeys: new Set([
        titulaireKey("w1", 1, "floor", "floor"),
        titulaireKey("w1", 2, "floor", "floor"),
      ]),
    });
    const weights = minimalWeights({ titulaireBonus: 80 });

    await solveCPSAT([w1], [slotMon, slotTue, slotWed], config, alwaysAvailable, undefined, undefined, weights);

    const bools = (capturedRequest.variables as any[]).filter(v => v.type === "bool" && v.name.startsWith("x_"));
    // Three vars in slot order — w1 on Mon, Tue, Wed.
    expect(findVarByName(capturedRequest, bools[0].name).coeff).toBe(Math.round((1000 + 80) * SCALE)); // Mon pinned
    expect(findVarByName(capturedRequest, bools[1].name).coeff).toBe(Math.round((1000 + 80) * SCALE)); // Tue pinned
    expect(findVarByName(capturedRequest, bools[2].name).coeff).toBe(Math.round(1000 * SCALE));        // Wed not
  });
});
