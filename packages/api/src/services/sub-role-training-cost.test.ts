import { describe, test, expect } from "bun:test";
import {
  TRAINING_COST_SAMPLES_THRESHOLD,
  TRAINING_COST_CLAMP_MIN_FACTOR,
  TRAINING_COST_CLAMP_MAX_FACTOR,
  crossTrainDefaultCost,
  intraTrainDefaultCost,
  defaultTrainingCost,
  bayesianUpdate,
  clampCost,
  successObservedCost,
  failureObservedCost,
  computeNextCostRow,
  resolveTrainingCost,
} from "./sub-role-training-cost";

// ── Hardcoded fallback costs ──
// These mirror the pre-learning optimize-engine constants. Tests pin them so
// a tuning change is a deliberate act, not a silent drift.

describe("crossTrainDefaultCost — pre-learning fallback", () => {
  test("high-skilled kitchen worker (Chef) → 28", () => {
    expect(crossTrainDefaultCost("Chef", "kitchen")).toBe(28);
  });
  test("Sous-chef → 28 (bestRank 1)", () => {
    expect(crossTrainDefaultCost("Sous-chef", "kitchen")).toBe(28);
  });
  test("Cuisinier → 20 (mid skill)", () => {
    expect(crossTrainDefaultCost("Cuisinier", "kitchen")).toBe(20);
  });
  test("Plongeur → 13 (low skill)", () => {
    expect(crossTrainDefaultCost("Plongeur", "kitchen")).toBe(13);
  });
  test("Unknown sub-role in kitchen → 13 (treated entry-level)", () => {
    expect(crossTrainDefaultCost("Magicien", "kitchen")).toBe(13);
  });
  test("Chef de rang (salle, rank 1) → 28", () => {
    expect(crossTrainDefaultCost("Chef de rang", "floor")).toBe(28);
  });
  test("Runner (salle, rank 4) → 13", () => {
    expect(crossTrainDefaultCost("Runner", "floor")).toBe(13);
  });
});

describe("intraTrainDefaultCost — asymmetric promotion/demotion fallback", () => {
  test("same sub-role → 5", () => {
    expect(intraTrainDefaultCost("Cuisinier", "Cuisinier", "kitchen")).toBe(5);
  });
  test("promotion path: Plongeur → Cuisinier is reasonable", () => {
    expect(intraTrainDefaultCost("Plongeur", "Cuisinier", "kitchen")).toBe(12);
  });
  test("senior promotion: Cuisinier → Chef is harder than Plongeur → Cuisinier", () => {
    expect(intraTrainDefaultCost("Cuisinier", "Chef", "kitchen")).toBeGreaterThan(intraTrainDefaultCost("Plongeur", "Cuisinier", "kitchen"));
  });
  test("demotion path: Chef → Plongeur is much more expensive than Plongeur → Cuisinier", () => {
    expect(intraTrainDefaultCost("Chef", "Plongeur", "kitchen")).toBe(40);
    expect(intraTrainDefaultCost("Chef", "Plongeur", "kitchen")).toBeGreaterThan(intraTrainDefaultCost("Plongeur", "Cuisinier", "kitchen"));
  });
  test("salle demotion is also expensive", () => {
    expect(intraTrainDefaultCost("Chef de rang", "Runner", "floor")).toBe(35);
  });
});

describe("defaultTrainingCost — dispatcher", () => {
  test("cross_train dispatches to crossTrainDefaultCost", () => {
    expect(defaultTrainingCost("cross_train", "Cuisinier", "floor", "kitchen")).toBe(20);
  });
  test("intra_train dispatches to intraTrainDefaultCost", () => {
    expect(defaultTrainingCost("intra_train", "Chef", "Plongeur", "kitchen")).toBe(40);
  });
});

// ── Pure Bayesian helpers ──

describe("bayesianUpdate", () => {
  test("α = 1/n moves a lot on first sample", () => {
    // prior 10, observed 5, n=1 → 0 * 10 + 1 * 5 = 5
    expect(bayesianUpdate(10, 5, 1)).toBe(5);
  });
  test("step size halves at n=2", () => {
    // prior 10, observed 5, n=2 → 0.5 * 10 + 0.5 * 5 = 7.5
    expect(bayesianUpdate(10, 5, 2)).toBe(7.5);
  });
  test("n → ∞ barely moves the prior", () => {
    const r = bayesianUpdate(10, 5, 100);
    expect(r).toBeCloseTo(9.95, 2);
  });
  test("n < 1 clamps to n = 1 (no divide-by-zero, no wild oscillation)", () => {
    expect(bayesianUpdate(10, 5, 0)).toBe(5);
    expect(bayesianUpdate(10, 5, -3)).toBe(5);
  });
});

describe("clampCost — learned cost bounded to [0.5×, 2×] default", () => {
  test("value inside window is returned unchanged", () => {
    expect(clampCost(15, 10)).toBe(15);
  });
  test("value below 0.5× → clamped to 0.5×", () => {
    expect(clampCost(2, 10)).toBe(5);
  });
  test("value above 2× → clamped to 2×", () => {
    expect(clampCost(50, 10)).toBe(20);
  });
  test("exact lower boundary returned as-is", () => {
    expect(clampCost(5, 10)).toBe(5);
  });
  test("exact upper boundary returned as-is", () => {
    expect(clampCost(20, 10)).toBe(20);
  });
});

describe("success/failure observed costs — clamp anchors", () => {
  test("successObservedCost == default × 0.5 (lower clamp anchor)", () => {
    expect(successObservedCost(20)).toBe(10);
    expect(successObservedCost(20)).toBe(20 * TRAINING_COST_CLAMP_MIN_FACTOR);
  });
  test("failureObservedCost == default × 2 (upper clamp anchor)", () => {
    expect(failureObservedCost(20)).toBe(40);
    expect(failureObservedCost(20)).toBe(20 * TRAINING_COST_CLAMP_MAX_FACTOR);
  });
});

// ── Pure outcome folding (computeNextCostRow) ──

describe("computeNextCostRow — pure Bayesian fold + clamp", () => {
  const DEFAULT = 20;

  test("no prior, success → seeded row pulls cost toward 0.5× default", () => {
    const r = computeNextCostRow({ prior: null, outcome: "success", defaultCost: DEFAULT });
    expect(r.skipped).toBe(false);
    expect(r.successes).toBe(1);
    expect(r.failures).toBe(0);
    // prior=default=20, observed=10, n=1 → 10
    expect(r.costPoints).toBe(10);
  });

  test("no prior, failure → seeded row pulls cost toward 2× default", () => {
    const r = computeNextCostRow({ prior: null, outcome: "failure", defaultCost: DEFAULT });
    expect(r.successes).toBe(0);
    expect(r.failures).toBe(1);
    // prior=20, observed=40, n=1 → 40. Clamp [10, 40] → 40.
    expect(r.costPoints).toBe(40);
  });

  test("successful outcomes move cost DOWN over time (acceptance criterion)", () => {
    // Float-epsilon tolerance: once the running average hits the lower clamp,
    // subsequent iterations can drift by ±1e-15 without breaking monotonicity.
    const EPS = 1e-9;
    let row: { costPoints: number; successes: number; failures: number; adminOverride: boolean } | null = null;
    let lastCost = DEFAULT;
    for (let i = 0; i < 10; i++) {
      const r = computeNextCostRow({ prior: row, outcome: "success", defaultCost: DEFAULT });
      expect(r.costPoints).toBeLessThanOrEqual(lastCost + EPS);
      lastCost = r.costPoints;
      row = { costPoints: r.costPoints, successes: r.successes, failures: r.failures, adminOverride: false };
    }
    // Eventually settles at the lower clamp.
    expect(lastCost).toBeCloseTo(DEFAULT * TRAINING_COST_CLAMP_MIN_FACTOR, 1);
  });

  test("failed outcomes move cost UP over time (acceptance criterion)", () => {
    const EPS = 1e-9;
    let row: { costPoints: number; successes: number; failures: number; adminOverride: boolean } | null = null;
    let lastCost = DEFAULT;
    for (let i = 0; i < 10; i++) {
      const r = computeNextCostRow({ prior: row, outcome: "failure", defaultCost: DEFAULT });
      expect(r.costPoints).toBeGreaterThanOrEqual(lastCost - EPS);
      lastCost = r.costPoints;
      row = { costPoints: r.costPoints, successes: r.successes, failures: r.failures, adminOverride: false };
    }
    // Eventually settles at the upper clamp.
    expect(lastCost).toBeCloseTo(DEFAULT * TRAINING_COST_CLAMP_MAX_FACTOR, 1);
  });

  test("cost stays clamped to [0.5×, 2×] no matter the observation stream (acceptance criterion)", () => {
    // Drive 50 successes then 50 failures — the running average never leaves the window.
    let row: { costPoints: number; successes: number; failures: number; adminOverride: boolean } | null = null;
    const low = DEFAULT * TRAINING_COST_CLAMP_MIN_FACTOR;
    const high = DEFAULT * TRAINING_COST_CLAMP_MAX_FACTOR;
    for (let i = 0; i < 50; i++) {
      const r = computeNextCostRow({ prior: row, outcome: "success", defaultCost: DEFAULT });
      expect(r.costPoints).toBeGreaterThanOrEqual(low);
      expect(r.costPoints).toBeLessThanOrEqual(high);
      row = { costPoints: r.costPoints, successes: r.successes, failures: r.failures, adminOverride: false };
    }
    for (let i = 0; i < 50; i++) {
      const r = computeNextCostRow({ prior: row!, outcome: "failure", defaultCost: DEFAULT });
      expect(r.costPoints).toBeGreaterThanOrEqual(low);
      expect(r.costPoints).toBeLessThanOrEqual(high);
      row = { costPoints: r.costPoints, successes: r.successes, failures: r.failures, adminOverride: false };
    }
  });

  test("adminOverride=true skips update and preserves prior cost (acceptance criterion)", () => {
    const prior = { costPoints: 17.3, successes: 4, failures: 2, adminOverride: true };
    const r = computeNextCostRow({ prior, outcome: "failure", defaultCost: DEFAULT });
    expect(r.skipped).toBe(true);
    expect(r.costPoints).toBe(17.3);
    expect(r.successes).toBe(4); // counters also untouched
    expect(r.failures).toBe(2);
  });
});

// ── Pure lookup (resolveTrainingCost) ──

describe("resolveTrainingCost — lookup with sample threshold", () => {
  const DEFAULT = 20;

  test("lookup with no data → returns hardcoded default (acceptance criterion)", () => {
    expect(resolveTrainingCost(null, DEFAULT)).toBe(DEFAULT);
  });

  test("fewer than threshold samples → still returns default", () => {
    for (let n = 1; n < TRAINING_COST_SAMPLES_THRESHOLD; n++) {
      const learned = { costPoints: 12, successes: n, failures: 0 };
      expect(resolveTrainingCost(learned, DEFAULT)).toBe(DEFAULT);
    }
  });

  test("exactly threshold samples → returns stored value (acceptance criterion)", () => {
    const learned = { costPoints: 12.5, successes: 3, failures: 2 };
    expect(learned.successes + learned.failures).toBe(TRAINING_COST_SAMPLES_THRESHOLD);
    expect(resolveTrainingCost(learned, DEFAULT)).toBe(12.5);
  });

  test("many samples → stored value wins over default", () => {
    const learned = { costPoints: 30, successes: 20, failures: 5 };
    expect(resolveTrainingCost(learned, DEFAULT)).toBe(30);
  });

  test("learningEnabled=false → always returns default, even with ample samples", () => {
    const learned = { costPoints: 12, successes: 50, failures: 0 };
    expect(resolveTrainingCost(learned, DEFAULT, { learningEnabled: false })).toBe(DEFAULT);
  });
});
