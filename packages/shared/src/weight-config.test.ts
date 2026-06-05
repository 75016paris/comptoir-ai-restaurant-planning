import { describe, test, expect } from "bun:test";
import {
  DEFAULT_WEIGHTS,
  PRESETS,
  PRESET_META,
  SEMANTIC_SCALE,
  DIMENSION_META,
  resolvePreset,
  resolveWeights,
  inferLevels,
  isPresetName,
} from "./weight-config";

describe("PresetName taxonomy (v2)", () => {
  test("exactly five presets", () => {
    expect(Object.keys(PRESETS).sort()).toEqual([
      "economique",
      "equilibre",
      "equipe-stable",
      "flexibilite",
      "resilience",
    ]);
  });

  test("PRESET_META aligned with PRESETS", () => {
    const metaNames = PRESET_META.map(p => p.name).sort();
    const presetNames = Object.keys(PRESETS).sort();
    expect(metaNames).toEqual(presetNames);
  });

  test("retired presets rejected", () => {
    expect(isPresetName("equite-max")).toBe(false);
    expect(isPresetName("ot-friendly")).toBe(false);
    expect(isPresetName("budget-serre")).toBe(false);
  });

  test("retired presets fall back to equilibre via resolvePreset", () => {
    expect(resolvePreset("equite-max")).toEqual(DEFAULT_WEIGHTS);
    expect(resolvePreset("ot-friendly")).toEqual(DEFAULT_WEIGHTS);
    expect(resolvePreset(null)).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("Redundancy dimension", () => {
  test("mild baseline in default (equilibre) — v2 calibrated", () => {
    // v2 calibration (2026-04-21) lifted redundancy from 0 to 15 (semantic level 1).
    // The fine sweep's peak+robust config cluster all sat at redundancy ≈ 14-17.
    expect(DEFAULT_WEIGHTS.redundancy).toBe(15);
    expect(PRESETS["equilibre"].redundancy).toBe(15);
  });

  test("resilience preset strictly stronger than default; flexibilite opts out", () => {
    expect(PRESETS["resilience"].redundancy).toBeGreaterThan(DEFAULT_WEIGHTS.redundancy);
    // equipe-stable / economique inherit the default baseline
    expect(PRESETS["equipe-stable"].redundancy).toBe(DEFAULT_WEIGHTS.redundancy);
    expect(PRESETS["economique"].redundancy).toBe(DEFAULT_WEIGHTS.redundancy);
    // flexibilite is the philosophical opposite of reserving versatile workers
    expect(PRESETS["flexibilite"].redundancy).toBe(0);
  });

  test("exposed as tunable dimension with 5-level scale", () => {
    const meta = DIMENSION_META.find(d => d.key === "redundancy");
    expect(meta).toBeDefined();
    expect(meta!.direction).toBe("positive");
    expect(meta!.group).toBe("resilience");
    expect(SEMANTIC_SCALE.redundancy).toHaveLength(5);
    // Monotonically increasing across the 5 levels
    for (let i = 1; i < 5; i++) {
      expect(SEMANTIC_SCALE.redundancy[i]).toBeGreaterThan(SEMANTIC_SCALE.redundancy[i - 1]);
    }
  });

  test("resilience preset value sits on the semantic scale", () => {
    const levels = inferLevels(PRESETS["resilience"]);
    expect(levels.redundancy).toBeGreaterThanOrEqual(1);
    expect(levels.redundancy).toBeLessThanOrEqual(4);
  });

  test("custom override on equilibre activates redundancy", () => {
    const withRedundancy = resolveWeights("equilibre", { redundancy: 3 });
    expect(withRedundancy.redundancy).toBe(SEMANTIC_SCALE.redundancy[3]);
  });
});

describe("Economique preset", () => {
  test("absolute-euros costAwareness + heavy OT penalties", () => {
    // costAwareness is absolute-euros (utils/solver-cost.ts): per-assignment coeff
    // = −CA × hours × €/hour. Unified across ILP and CP-SAT.
    const p = PRESETS["economique"];
    expect(p.costAwareness).toBeGreaterThan(0);
    expect(p.contractCompletion).toBeGreaterThan(DEFAULT_WEIGHTS.contractCompletion);
    expect(p.bucket0Value).toBeGreaterThan(DEFAULT_WEIGHTS.bucket0Value);
    expect(p.bucket1Value).toBe(0);
    expect(p.bucket2Penalty).toBeGreaterThan(DEFAULT_WEIGHTS.bucket2Penalty);
    expect(p.bucket3Penalty).toBeGreaterThan(DEFAULT_WEIGHTS.bucket3Penalty);
  });
});

describe("Resilience preset (structural)", () => {
  test("flat workload — kills priority, loosens consistency", () => {
    // Redefined 2026-04-21 from "versatile reserves" (no working lever) to
    // "flat workload distribution" (measurable via workloadSpread / Gini).
    // See the internal resilience redefinition note.
    const p = PRESETS["resilience"];
    expect(p.priority).toBeLessThan(DEFAULT_WEIGHTS.priority);
    expect(p.consistency).toBeLessThan(DEFAULT_WEIGHTS.consistency);
    expect(p.redundancy).toBeGreaterThan(DEFAULT_WEIGHTS.redundancy);
  });
});
