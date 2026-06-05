import { describe, test, expect, afterEach } from "bun:test";
import {
  addHintEnabledForPreset,
  __resetAddHintPolicy,
} from "./addhint-policy";

// Pin the ADDHINT_DISABLED_PRESETS env contract documented by the
// cross-preset AddHint sweep. The helper is called on the hint-load hot path
// in multi-week-solver.ts, so the memoization must
// flip when the env changes — tests use __resetAddHintPolicy to force re-parse.

const ENV = "ADDHINT_DISABLED_PRESETS";
const PRESETS = ["equilibre", "equipe-stable", "flexibilite", "economique", "resilience"];

describe("addHintEnabledForPreset", () => {
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
    __resetAddHintPolicy();
  });

  test("unset → all presets enabled", () => {
    delete process.env[ENV];
    __resetAddHintPolicy();
    for (const p of PRESETS) {
      expect(addHintEnabledForPreset(p)).toBe(true);
    }
  });

  test("empty string → all presets enabled", () => {
    process.env[ENV] = "";
    __resetAddHintPolicy();
    for (const p of PRESETS) {
      expect(addHintEnabledForPreset(p)).toBe(true);
    }
  });

  test('single preset "economique" → economique disabled, others enabled', () => {
    process.env[ENV] = "economique";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset("economique")).toBe(false);
    for (const p of PRESETS.filter(p => p !== "economique")) {
      expect(addHintEnabledForPreset(p)).toBe(true);
    }
  });

  test('multiple presets "economique,resilience" → both disabled, others enabled', () => {
    process.env[ENV] = "economique,resilience";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset("economique")).toBe(false);
    expect(addHintEnabledForPreset("resilience")).toBe(false);
    for (const p of ["equilibre", "equipe-stable", "flexibilite"]) {
      expect(addHintEnabledForPreset(p)).toBe(true);
    }
  });

  test("whitespace around entries is tolerated", () => {
    process.env[ENV] = "  economique , resilience  ";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset("economique")).toBe(false);
    expect(addHintEnabledForPreset("resilience")).toBe(false);
    expect(addHintEnabledForPreset("equilibre")).toBe(true);
  });

  test("case-sensitive match (documented choice — mirrors PresetName lowercase kebab-case)", () => {
    // "Economique" in the env does not match the lowercase preset name
    // "economique" — a typo silently no-ops rather than being auto-fixed.
    // This matches how other solver env flags (TEMPLATE_MATCH_ENABLED,
    // CPSAT_SYMMETRY_BREAK) treat their values as exact strings.
    process.env[ENV] = "Economique";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset("economique")).toBe(true);
    expect(addHintEnabledForPreset("Economique")).toBe(false);
  });

  test("null / undefined / empty preset name → enabled (no gate)", () => {
    process.env[ENV] = "economique";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset(null)).toBe(true);
    expect(addHintEnabledForPreset(undefined)).toBe(true);
    expect(addHintEnabledForPreset("")).toBe(true);
  });

  test("parse result memoizes against raw env value", () => {
    process.env[ENV] = "economique";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset("economique")).toBe(false);
    // Change env without calling __resetAddHintPolicy — memoization key is
    // the raw string, so the change IS picked up next call.
    process.env[ENV] = "resilience";
    expect(addHintEnabledForPreset("economique")).toBe(true);
    expect(addHintEnabledForPreset("resilience")).toBe(false);
  });

  test("trailing / embedded empty entries are ignored", () => {
    process.env[ENV] = ",economique,,resilience,";
    __resetAddHintPolicy();
    expect(addHintEnabledForPreset("economique")).toBe(false);
    expect(addHintEnabledForPreset("resilience")).toBe(false);
    expect(addHintEnabledForPreset("")).toBe(true); // empty string never matches
  });
});
