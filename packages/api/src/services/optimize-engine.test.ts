import { describe, test, expect } from "bun:test";
import { computeFinalSurplusPenalty, computePerfectionScore, computePlanRankScore, planWorsensUnderstaffing, PERFECTION_WEIGHTS, SURPLUS_OBJECTIVE, formatContractBumpSummary, formatMaxWeeklySummary, isPracticalContractReductionForCompound, resolveSolverBudgetConfig, scoreRecommendationForDisplay } from "./optimize-engine";
import type { OptimizationRecommendation, OptimizeImpact } from "./optimize-engine";

// Minimal impact factory — callers override just the fields they care about.
const impactOf = (surplus: Record<string, number> = {}, understaffed: Record<string, number> = {}) =>
  ({ surplusHoursDelta: surplus, understaffedSlotsDelta: understaffed }) as Pick<OptimizeImpact, "surplusHoursDelta" | "understaffedSlotsDelta">;

const noop = impactOf();

const recOf = (overrides: Partial<OptimizationRecommendation>): OptimizationRecommendation => ({
  id: "rec",
  type: "reduce_to_planned",
  label: "Test",
  description: "Test",
  workerId: "w1",
  workerName: "Worker",
  role: "kitchen",
  contractType: "CDI",
  currentValue: 35,
  proposedValue: 12,
  impact: { surplusHoursDelta: {}, understaffedSlotsDelta: {}, hoursRedistributed: 0, affectedWorkers: [] },
  score: 100,
  ...overrides,
});

// Reusable neutral baseline: 0 surplus, 0 understaffed, no OT capacity.
const neutral = {
  baseSurplusByRole: { kitchen: 0, floor: 0 },
  baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
  otCapacityByRole: { kitchen: 0, floor: 0 },
};

describe("resolveSolverBudgetConfig", () => {
  test("defaults to a larger budget and derives phase caps proportionally", () => {
    expect(resolveSolverBudgetConfig("")).toEqual({
      solverBudget: 160,
      phase1BudgetCap: 107,
      phase2BudgetCap: 147,
      phase3BudgetCap: 160,
    });
  });

  test("honors OPTIMIZE_SOLVER_BUDGET=200 with original phase ratios", () => {
    expect(resolveSolverBudgetConfig("200")).toEqual({
      solverBudget: 200,
      phase1BudgetCap: 133,
      phase2BudgetCap: 183,
      phase3BudgetCap: 200,
    });
  });

  test("falls back to default on invalid env values", () => {
    expect(resolveSolverBudgetConfig("not-a-number").solverBudget).toBe(160);
  });
});

describe("computePerfectionScore — baseline", () => {
  test("no impact, no moves → baseline 1000", () => {
    const s = computePerfectionScore({ ...neutral, impact: noop, moveCostTotal: 0 });
    expect(s).toBe(1000);
  });

  test("existing surplus uses structural-waste penalty tiers per role", () => {
    const s = computePerfectionScore({
      baseSurplusByRole: { kitchen: 20, floor: 10 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 0, floor: 0 },
      impact: noop,
      moveCostTotal: 0,
    });
    // kitchen +20h => 4×2 + 4×7 + 12×12 = 180; floor +10h => 4×2 + 4×7 + 2×12 = 60
    expect(s).toBe(760);
  });

  test("existing understaffing reduces baseline by 60 per slot per role", () => {
    const s = computePerfectionScore({
      ...neutral,
      baseUnderstaffedByRole: { kitchen: 2, floor: 1 },
      impact: noop,
      moveCostTotal: 0,
    });
    // 1000 − 2×60 − 1×60 = 820
    expect(s).toBe(820);
  });
});

describe("computePerfectionScore — surplus branch thresholds", () => {
  test("deficit within willing OT capacity uses sweet-spot bonus + light penalty", () => {
    const s = computePerfectionScore({
      baseSurplusByRole: { kitchen: -10, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 20, floor: 0 },
      impact: noop,
      moveCostTotal: 0,
    });
    // covered=10 → sweet=4 (bonus 8), beyondSweet=6 (penalty 7.5). Net −0.5 → 1000.5 → 1001
    expect(s).toBe(1001);
  });

  test("deficit beyond willing OT uses heavy 25/h penalty on the overflow", () => {
    const s = computePerfectionScore({
      baseSurplusByRole: { kitchen: -30, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 10, floor: 0 },
      impact: noop,
      moveCostTotal: 0,
    });
    // covered=10 (sweet=4 → −8, beyondSweet=6 → 7.5), overflow=20×25=500. Net 499.5 → 500.5 → 501
    expect(s).toBe(501);
  });

  test("positive surplus above 8h is penalized as persistent waste regardless of OT capacity", () => {
    const s = computePerfectionScore({
      baseSurplusByRole: { kitchen: 15, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 50, floor: 0 },
      impact: noop,
      moveCostTotal: 0,
    });
    expect(s).toBe(880);
  });
});

describe("computePerfectionScore — final surplus objective", () => {
  test("cutting 30h of structural surplus without creating understaffing is preferred over no-op", () => {
    const baselineArgs = {
      baseSurplusByRole: { kitchen: 30, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 20, floor: 0 },
      moveCostTotal: 0,
    };
    const noMove = computePerfectionScore({ ...baselineArgs, impact: noop });
    const cut30 = computePerfectionScore({ ...baselineArgs, impact: impactOf({ kitchen: -30 }) });
    expect(cut30).toBeGreaterThan(noMove);
  });

  test("small willing-OT-covered deficit beats persistent +15h paid surplus", () => {
    const args = {
      baseSurplusByRole: { kitchen: 15, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 20, floor: 0 },
      moveCostTotal: 0,
    };
    const keepSurplus = computePerfectionScore({ ...args, impact: noop });
    const slightDeficit = computePerfectionScore({ ...args, impact: impactOf({ kitchen: -25 }) });
    expect(slightDeficit).toBeGreaterThan(keepSurplus);
  });

  test("negative surplus beyond willing OT is worse than keeping moderate positive surplus", () => {
    const args = {
      baseSurplusByRole: { kitchen: 10, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 0, floor: 0 },
      moveCostTotal: 0,
    };
    const keepSurplus = computePerfectionScore({ ...args, impact: noop });
    const uncoveredDeficit = computePerfectionScore({ ...args, impact: impactOf({ kitchen: -20 }) });
    expect(uncoveredDeficit).toBeLessThan(keepSurplus);
  });

  test("coverage remains primary: creating an unfilled slot loses even if it removes a small surplus", () => {
    const args = {
      baseSurplusByRole: { kitchen: 4, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 20, floor: 0 },
      moveCostTotal: 0,
    };
    const noMove = computePerfectionScore({ ...args, impact: noop });
    const cutAndRisk = computePerfectionScore({ ...args, impact: impactOf({ kitchen: -4 }, { kitchen: 1 }) });
    expect(cutAndRisk).toBeLessThan(noMove);
  });

  test("removing an existing unfilled slot can justify a small positive buffer", () => {
    const args = {
      baseSurplusByRole: { kitchen: 0, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 1, floor: 0 },
      otCapacityByRole: { kitchen: 0, floor: 0 },
      moveCostTotal: 0,
    };
    const noMove = computePerfectionScore({ ...args, impact: noop });
    const filled = computePerfectionScore({ ...args, impact: impactOf({ kitchen: 4 }, { kitchen: -1 }) });
    expect(filled).toBeGreaterThan(noMove);
  });

  test("penalty tiers make +8h and +15h structural surplus visibly bad", () => {
    expect(computeFinalSurplusPenalty(4, 20)).toBe(8);
    expect(computeFinalSurplusPenalty(8, 20)).toBe(36);
    expect(computeFinalSurplusPenalty(15, 20)).toBe(120);
  });

  test("temporary OT-covered termination beats keeping +25h of paid waste", () => {
    const keepWaste = computePerfectionScore({
      baseSurplusByRole: { kitchen: 25, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 0, floor: 0 },
      impact: noop,
      moveCostTotal: 0,
    });
    const terminateWithoutOt = computePerfectionScore({
      baseSurplusByRole: { kitchen: 25, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 0, floor: 0 },
      impact: impactOf({ kitchen: -35 }),
      moveCostTotal: 8,
    });
    const terminateCoveredByOt = computePerfectionScore({
      baseSurplusByRole: { kitchen: 25, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 20, floor: 0 },
      impact: impactOf({ kitchen: -35 }),
      moveCostTotal: 40,
    });

    expect(terminateWithoutOt).toBeLessThan(keepWaste);
    expect(terminateCoveredByOt).toBeGreaterThan(keepWaste);
  });
});

describe("computePerfectionScore — moveCost subtraction", () => {
  test("moveCostTotal is subtracted verbatim", () => {
    const s = computePerfectionScore({ ...neutral, impact: noop, moveCostTotal: 17 });
    expect(s).toBe(1000 - 17);
  });

  test("higher move cost can flip an otherwise-positive plan", () => {
    const base = {
      baseSurplusByRole: { kitchen: 15, floor: 0 },
      baseUnderstaffedByRole: { kitchen: 0, floor: 0 },
      otCapacityByRole: { kitchen: 0, floor: 0 },
      impact: impactOf({ kitchen: -15 }), // removes all surplus → +45 score
    };
    const noMove = computePerfectionScore({ ...base, moveCostTotal: 0, impact: noop });
    const cheapMove = computePerfectionScore({ ...base, moveCostTotal: 10 });
    const expensiveMove = computePerfectionScore({ ...base, moveCostTotal: 130 });
    expect(cheapMove).toBeGreaterThan(noMove);
    expect(expensiveMove).toBeLessThan(noMove);
  });
});

describe("isPracticalContractReductionForCompound", () => {
  test("allows CDI/CDD deep cuts so the optimizer can address heavy surplus", () => {
    // These previously were diagnostic-only and got filtered out of compound
    // plans, leaving heavily-overstaffed teams with cosmetic reductions only.
    // The move cost in deepContractReductionCost already encodes HR difficulty.
    expect(isPracticalContractReductionForCompound({ contractType: "CDI", currentValue: 35, proposedValue: 17 })).toBe(true);
    expect(isPracticalContractReductionForCompound({ contractType: "CDI", currentValue: 39, proposedValue: 22 })).toBe(true);
    expect(isPracticalContractReductionForCompound({ contractType: "CDD", currentValue: 35, proposedValue: 25 })).toBe(true);
    expect(isPracticalContractReductionForCompound({ contractType: "CDI", currentValue: 39, proposedValue: 35 })).toBe(true);
  });

  test("saisonnier stays flexible at any reduction depth", () => {
    expect(isPracticalContractReductionForCompound({ contractType: "saisonnier", currentValue: 35, proposedValue: 10 })).toBe(true);
    expect(isPracticalContractReductionForCompound({ contractType: "saisonnier", currentValue: 35, proposedValue: 5 })).toBe(true);
  });

  test("blocks near-termination CDI/CDD cuts (should be an explicit terminate)", () => {
    expect(isPracticalContractReductionForCompound({ contractType: "CDI", currentValue: 35, proposedValue: 6 })).toBe(false);
    expect(isPracticalContractReductionForCompound({ contractType: "CDD", currentValue: 39, proposedValue: 5 })).toBe(false);
  });
});

describe("scoreRecommendationForDisplay — HR feasibility ranking", () => {
  test("CDD non-renewal outranks a drastic CDI reduction even with lower raw impact", () => {
    const cdiReduction = recOf({
      type: "reduce_to_planned",
      contractType: "CDI",
      currentValue: 35,
      proposedValue: 11,
      score: 132,
    });
    const cddNonRenewal = recOf({
      type: "terminate",
      contractType: "CDD",
      currentValue: 35,
      proposedValue: 0,
      score: 105,
    });

    expect(scoreRecommendationForDisplay(cddNonRenewal)).toBeGreaterThan(scoreRecommendationForDisplay(cdiReduction));
  });

  test("CDD non-renewal outranks reducing the same CDD below 24h", () => {
    const cddReduction = recOf({
      type: "reduce_to_planned",
      contractType: "CDD",
      currentValue: 35,
      proposedValue: 12,
      score: 129,
    });
    const cddNonRenewal = recOf({
      type: "terminate",
      contractType: "CDD",
      currentValue: 35,
      proposedValue: 0,
      score: 105,
    });

    expect(scoreRecommendationForDisplay(cddNonRenewal)).toBeGreaterThan(scoreRecommendationForDisplay(cddReduction));
  });

  test("CDI termination is less penalized than a CDI 35h to 11h reduction when raw impact is comparable", () => {
    const cdiReduction = recOf({
      type: "reduce_to_planned",
      contractType: "CDI",
      currentValue: 35,
      proposedValue: 11,
      score: 132,
    });
    const cdiTermination = recOf({
      type: "terminate",
      contractType: "CDI",
      currentValue: 39,
      proposedValue: 0,
      score: 117,
    });

    expect(scoreRecommendationForDisplay(cdiTermination)).toBeGreaterThan(scoreRecommendationForDisplay(cdiReduction));
  });

  test("terminate variants with practical absorption get a small display boost", () => {
    const plain = recOf({ type: "terminate", contractType: "CDD", currentValue: 35, proposedValue: 0, score: 105 });
    const withOt = recOf({
      type: "terminate",
      contractType: "CDD",
      currentValue: 35,
      proposedValue: 0,
      score: 105,
      contractOverrides: { removed: 0 },
      maxWeeklyOverrides: { willing: 46 },
    });

    expect(scoreRecommendationForDisplay(withOt)).toBeGreaterThan(scoreRecommendationForDisplay(plain));
  });

  test("formats 39h contract bump summaries", () => {
    expect(formatContractBumpSummary(
      { removed: 0, francois: 39, audrey: 39 },
      [
        { workerId: "removed", workerName: "Guillaume", contractHours: 35 },
        { workerId: "francois", workerName: "François Cluzet", contractHours: 35 },
        { workerId: "audrey", workerName: "Audrey Tautou", contractHours: 35 },
      ],
      "removed",
    )).toBe("François Cluzet 35h→39h, Audrey Tautou 35h→39h");
  });

  test("formats 46h overtime summaries", () => {
    expect(formatMaxWeeklySummary(
      { francois: 46, audrey: 46 },
      [
        { workerId: "francois", workerName: "François Cluzet" },
        { workerId: "audrey", workerName: "Audrey Tautou" },
      ],
    )).toBe("François Cluzet jusqu'à 46h, Audrey Tautou jusqu'à 46h");
  });

  test("39h to 35h CDI/CDD reductions remain easy and visible", () => {
    const cdiReduction = recOf({
      type: "reduce_to_planned",
      contractType: "CDI",
      currentValue: 39,
      proposedValue: 35,
      score: 30,
    });
    const cddReduction = recOf({
      type: "reduce_to_planned",
      contractType: "CDD",
      currentValue: 39,
      proposedValue: 35,
      score: 30,
    });

    expect(scoreRecommendationForDisplay(cdiReduction)).toBeGreaterThan(0);
    expect(scoreRecommendationForDisplay(cddReduction)).toBeGreaterThan(scoreRecommendationForDisplay(cdiReduction));
  });

  test("deeper CDI/CDD reductions are expensive, saisonnier reductions are easy", () => {
    const cdiDeepReduction = recOf({ type: "reduce_to_planned", contractType: "CDI", currentValue: 35, proposedValue: 25, score: 80 });
    const cddDeepReduction = recOf({ type: "reduce_to_planned", contractType: "CDD", currentValue: 39, proposedValue: 20, score: 80 });
    const seasonalReduction = recOf({ type: "reduce_to_planned", contractType: "saisonnier", currentValue: 35, proposedValue: 10, score: 30 });

    expect(scoreRecommendationForDisplay(cdiDeepReduction)).toBeLessThan(0);
    expect(scoreRecommendationForDisplay(cddDeepReduction)).toBeLessThan(0);
    expect(scoreRecommendationForDisplay(seasonalReduction)).toBeGreaterThan(30);
  });

  test("adding hours up to 39h is easy", () => {
    const increase = recOf({ type: "increase_hours", contractType: "CDI", currentValue: 35, proposedValue: 39, score: 10 });

    expect(scoreRecommendationForDisplay(increase)).toBeGreaterThan(10);
  });
});

describe("planWorsensUnderstaffing", () => {
  test("rejects plans that reduce surplus by creating more understaffed slots", () => {
    const plan = {
      finalState: { floor: { surplus: 31, understaffed: 6, verdict: "undersized" } },
    };

    expect(planWorsensUnderstaffing({ plan, baseUnderstaffedByRole: { floor: 2 }, roles: ["floor"] })).toBe(true);
  });

  test("allows plans that keep or improve understaffing", () => {
    const plan = {
      finalState: { floor: { surplus: 40, understaffed: 2, verdict: "tight" } },
    };

    expect(planWorsensUnderstaffing({ plan, baseUnderstaffedByRole: { floor: 2 }, roles: ["floor"] })).toBe(false);
  });

  test("accepts new understaffed slots when the resulting deficit is OT-coverable", () => {
    const plan = {
      finalState: { floor: { surplus: -5, understaffed: 3, verdict: "balanced" } },
    };

    expect(planWorsensUnderstaffing({
      plan,
      baseUnderstaffedByRole: { floor: 1 },
      otCapacityByRole: { floor: 10 },
      roles: ["floor"],
    })).toBe(false);
  });

  test("rejects new understaffed slots when the deficit exceeds OT capacity", () => {
    const plan = {
      finalState: { floor: { surplus: -20, understaffed: 4, verdict: "undersized" } },
    };

    expect(planWorsensUnderstaffing({
      plan,
      baseUnderstaffedByRole: { floor: 1 },
      otCapacityByRole: { floor: 8 },
      roles: ["floor"],
    })).toBe(true);
  });

  test("tolerates a small structural shortfall — score function weighs slots against surplus cut", () => {
    // Plan adds 2 new unfilled slots while surplus is still positive (no
    // deficit for OT to cover). The score function penalises each slot at
    // 60 pt, so the optimizer will only land here when the surplus reduction
    // clearly outweighs — that's the right place for the tradeoff.
    const plan = {
      finalState: { floor: { surplus: 5, understaffed: 3, verdict: "tight" } },
    };

    expect(planWorsensUnderstaffing({
      plan,
      baseUnderstaffedByRole: { floor: 1 },
      otCapacityByRole: { floor: 20 },
      roles: ["floor"],
    })).toBe(false);
  });

  test("rejects catastrophic coverage loss (many new structural shortfalls)", () => {
    const plan = {
      finalState: { floor: { surplus: 30, understaffed: 8, verdict: "tight" } },
    };

    expect(planWorsensUnderstaffing({
      plan,
      baseUnderstaffedByRole: { floor: 1 },
      otCapacityByRole: { floor: 0 },
      roles: ["floor"],
    })).toBe(true);
  });
});

describe("computeFinalSurplusPenalty — sweet-spot attractor", () => {
  test("tiny surplus is at least as costly as the same OT-covered deficit", () => {
    expect(computeFinalSurplusPenalty(1, 20)).toBeGreaterThan(computeFinalSurplusPenalty(-1, 20));
    expect(computeFinalSurplusPenalty(2, 20)).toBeGreaterThan(computeFinalSurplusPenalty(-2, 20));
  });

  test("preferred landing is a small OT-coverable deficit (minimum near −4h)", () => {
    const zero = computeFinalSurplusPenalty(0, 20);
    const minusOne = computeFinalSurplusPenalty(-1, 20);
    const minusFour = computeFinalSurplusPenalty(-4, 20);
    const minusTen = computeFinalSurplusPenalty(-10, 20);
    expect(minusFour).toBeLessThan(minusOne);
    expect(minusFour).toBeLessThan(zero);
    expect(minusFour).toBeLessThan(minusTen);
  });

  test("sweet-spot bonus does not apply when OT capacity is zero", () => {
    expect(computeFinalSurplusPenalty(-4, 0)).toBe(4 * SURPLUS_OBJECTIVE.deficitBeyondWillingOtPenaltyPerHour);
  });
});

describe("computePlanRankScore", () => {
  test("selects a low-surplus restructuring plan over a conservative paid-waste plan", () => {
    const conservative = {
      totalScore: 930,
      finalState: { kitchen: { surplus: 25, understaffed: 0, verdict: "oversized" } },
    };
    const restructuring = {
      totalScore: 880,
      finalState: { kitchen: { surplus: 4, understaffed: 0, verdict: "balanced" } },
    };

    expect(computePlanRankScore({ plan: restructuring, roles: ["kitchen"] }))
      .toBeGreaterThan(computePlanRankScore({ plan: conservative, roles: ["kitchen"] }));
  });

  test("slight OT-covered negative surplus ranks above large positive waste", () => {
    const positiveWaste = {
      totalScore: 900,
      finalState: { kitchen: { surplus: 25, understaffed: 0, verdict: "oversized" } },
    };
    const coveredDeficit = {
      totalScore: 900,
      finalState: { kitchen: { surplus: -4, understaffed: 0, verdict: "balanced" } },
    };

    expect(computePlanRankScore({ plan: coveredDeficit, roles: ["kitchen"], otCapacityByRole: { kitchen: 10 } }))
      .toBeGreaterThan(computePlanRankScore({ plan: positiveWaste, roles: ["kitchen"], otCapacityByRole: { kitchen: 10 } }));
  });

  test("middle-ground plan beats both high-understaffing lean and huge-waste conservative extremes", () => {
    const leanRisky = {
      totalScore: 520,
      finalState: { floor: { surplus: 15, understaffed: 6, verdict: "undersized" } },
    };
    const middleGround = {
      totalScore: 340,
      finalState: { floor: { surplus: 45, understaffed: 3, verdict: "undersized" } },
    };
    const hugeWaste = {
      totalScore: -128,
      finalState: { floor: { surplus: 89, understaffed: 2, verdict: "undersized" } },
    };

    expect(computePlanRankScore({ plan: middleGround, roles: ["floor"] }))
      .toBeGreaterThan(computePlanRankScore({ plan: leanRisky, roles: ["floor"] }));
    expect(computePlanRankScore({ plan: middleGround, roles: ["floor"] }))
      .toBeGreaterThan(computePlanRankScore({ plan: hugeWaste, roles: ["floor"] }));
  });
});

describe("computePerfectionScore — weight contract", () => {
  // Pins the exported constants so tuning goes through the named config,
  // not via magic-number hunts. If someone edits the constants, this fails.
  test("weights match documented values", () => {
    expect(PERFECTION_WEIGHTS).toEqual({
      baseline: 1000,
      surplusPerHour: 3,
      deficitCoveredByOtPerHour: 1.5,
      deficitBeyondOtPerHour: 25,
      understaffedPerSlot: 60,
    });
    expect(SURPLUS_OBJECTIVE).toEqual({
      positiveWarningHours: 4,
      positiveBadHours: 8,
      positiveWarningPenaltyPerHour: 2,
      positiveBadPenaltyPerHour: 7,
      positiveWastePenaltyPerHour: 12,
      willingOtPenaltyPerHour: 1.25,
      deficitBeyondWillingOtPenaltyPerHour: 25,
      sweetSpotMaxHours: 4,
      sweetSpotBonusPerHour: 2,
    });
  });
});
