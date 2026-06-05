/**
 * Sign-symmetric integer rounding. JS `Math.round` rounds half-values
 * toward +∞ (`Math.round(-0.5) = 0`, `Math.round(0.5) = 1`), which is
 * asymmetric for negative coefficients. This rounds half-values away
 * from zero in both directions so ±|x| map to ±round(|x|). See audit L14.
 */
export function roundAwayFromZero(x: number): number {
  // `|| 0` collapses the `-0` produced by `-Math.round(0.49)` to `+0`.
  return x < 0 ? -Math.round(-x) || 0 : Math.round(x);
}
