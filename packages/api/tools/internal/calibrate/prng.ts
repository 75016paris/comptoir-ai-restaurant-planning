// Mulberry32 — small, fast, fully deterministic seedable PRNG.
// Calibration sweeps must be reproducible: same seed → same restaurant → same metrics.

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function range(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function rangeInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(range(rng, lo, hi + 1));
}

export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}

// Latin hypercube sampling: N samples × D dimensions, each dim stratified into N bins.
// Produces a more uniform coverage of the hyper-cube than independent uniform draws.
export function latinHypercube(rng: () => number, n: number, dims: number): number[][] {
  const samples: number[][] = [];
  // Per-dimension permutation of [0..n-1]
  const perms: number[][] = [];
  for (let d = 0; d < dims; d++) {
    const p = Array.from({ length: n }, (_, i) => i);
    // Fisher-Yates shuffle with our PRNG
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    perms.push(p);
  }
  for (let i = 0; i < n; i++) {
    const sample: number[] = [];
    for (let d = 0; d < dims; d++) {
      // Each dim's i-th sample lives in stratum perms[d][i] of [0,1].
      sample.push((perms[d][i] + rng()) / n);
    }
    samples.push(sample);
  }
  return samples;
}
