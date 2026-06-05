import { describe, test, expect } from "bun:test";
import { roundAwayFromZero } from "./cpsat-rounding.js";

// Audit L14: JS `Math.round` rounds half-values toward +∞, so
// `Math.round(-0.5) = 0` but `Math.round(0.5) = 1`. For CP-SAT
// objective coefficients that can be negative (per-assignment
// accumulator at cpsat-solver.ts:325, bucket-penalty coeffs at
// cpsat-solver.ts:335), we want symmetric rounding of half-values
// so that ±|x| map to ±round(|x|).

describe("roundAwayFromZero", () => {
  test("negative half rounds away from zero", () => {
    expect(roundAwayFromZero(-0.5)).toBe(-1);
  });

  test("positive half rounds away from zero", () => {
    expect(roundAwayFromZero(0.5)).toBe(1);
  });

  test("negative below half rounds toward zero", () => {
    expect(roundAwayFromZero(-0.49)).toBe(0);
  });

  test("positive below half rounds toward zero", () => {
    expect(roundAwayFromZero(0.49)).toBe(0);
  });

  test("negative 1.5 rounds to -2", () => {
    expect(roundAwayFromZero(-1.5)).toBe(-2);
  });

  test("positive 1.5 rounds to 2", () => {
    expect(roundAwayFromZero(1.5)).toBe(2);
  });

  test("zero maps to zero", () => {
    expect(roundAwayFromZero(0)).toBe(0);
  });

  test("integers are preserved", () => {
    expect(roundAwayFromZero(-3)).toBe(-3);
    expect(roundAwayFromZero(3)).toBe(3);
  });

  test("symmetric across sign for all half-values in ±10", () => {
    for (let k = 0; k <= 10; k++) {
      const h = k + 0.5;
      expect(roundAwayFromZero(-h)).toBe(-roundAwayFromZero(h));
    }
  });
});
