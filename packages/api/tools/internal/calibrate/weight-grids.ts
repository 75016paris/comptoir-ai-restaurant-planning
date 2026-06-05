// Weight-config grids for sweeps.
//
// Coarse grid: log-scale around defaults — find the right region.
// Fine grid: narrow around best coarse config — refine.
//
// Strategy: factor-decomposed (one parameter swept at a time), not full factorial,
// to keep #configs reasonable. The harness can also accept hand-rolled configs.

import { DEFAULT_WEIGHTS, PRESETS, type WeightConfig } from "@comptoir/shared";

export function coarseGrid(): WeightConfig[] {
  const out: WeightConfig[] = [DEFAULT_WEIGHTS];

  // Per-axis variations with WIDE ranges (×0.1 / ×10) after round-1 showed ×0.3/×3 was too narrow.
  const axes: Array<{ key: keyof WeightConfig; lo: number; hi: number }> = [
    { key: "fill", lo: 0.2, hi: 5 },
    { key: "bucket0Value", lo: 0.1, hi: 10 },
    { key: "bucket1Value", lo: 0.1, hi: 10 },
    { key: "bucket2Penalty", lo: 0.1, hi: 10 },
    { key: "bucket3Penalty", lo: 0.1, hi: 10 },
    { key: "bucket2OtOffset", lo: 0, hi: 2 },
    { key: "bucket3OtOffset", lo: 0, hi: 2 },
    { key: "consistency", lo: 0.1, hi: 10 },
    { key: "preference", lo: 0.1, hi: 10 },
    { key: "priority", lo: 0.1, hi: 10 },
    { key: "flexibility", lo: 0.1, hi: 10 },
    { key: "subroleMismatch", lo: 0.1, hi: 10 },
    { key: "rolePenalty", lo: 0.1, hi: 10 },
  ];
  for (const { key, lo, hi } of axes) {
    for (const mult of [lo, hi]) {
      const c: WeightConfig = { ...DEFAULT_WEIGHTS };
      const v = (DEFAULT_WEIGHTS[key] as number) * mult;
      if (key === "bucket2OtOffset" || key === "bucket3OtOffset") {
        (c[key] as number) = Math.max(0, Math.min(1, v));
      } else {
        (c[key] as number) = v;
      }
      out.push(c);
    }
  }

  // JOINT shifts — hypothesis-driven combinations.
  out.push({ ...DEFAULT_WEIGHTS, // A: aggressive OT-friendly (willing workers get hammered)
    bucket1Value: 60, bucket2Penalty: 15, bucket3Penalty: 40,
    bucket2OtOffset: 0.95, bucket3OtOffset: 0.9,
  });
  out.push({ ...DEFAULT_WEIGHTS, // B: strict-OT — spread across team
    bucket1Value: 5, bucket2Penalty: 150, bucket3Penalty: 400,
    bucket2OtOffset: 0.2, bucket3OtOffset: 0.1,
  });
  out.push({ ...DEFAULT_WEIGHTS, // C: priority-heavy — seniors get shifts first
    priority: 20, consistency: 20, flexibility: 5,
  });
  out.push({ ...DEFAULT_WEIGHTS, // D: fairness-first — flat treatment
    priority: 0, consistency: 1, flexibility: 0,
    bucket0Value: 100, bucket1Value: 40,
  });
  out.push({ ...DEFAULT_WEIGHTS, // E: sub-role-strict
    subroleMismatch: 3000, rolePenalty: 2000,
  });
  out.push({ ...DEFAULT_WEIGHTS, // F: sub-role-lax
    subroleMismatch: 100, rolePenalty: 50,
  });
  out.push({ ...DEFAULT_WEIGHTS, // G: contract-adherence-focused
    bucket0Value: 300, bucket1Value: 5, bucket2Penalty: 150, bucket3Penalty: 500,
  });
  out.push({ ...DEFAULT_WEIGHTS, // H: consistency-focused (week-over-week stability)
    consistency: 40, preference: 15,
  });
  out.push({ ...DEFAULT_WEIGHTS, // I: balanced reset — everything equal-ish
    fill: 1000, bucket0Value: 100, bucket1Value: 30, bucket2Penalty: 50, bucket3Penalty: 120,
    consistency: 10, preference: 5, priority: 5, flexibility: 2,
    subroleMismatch: 500, rolePenalty: 300,
  });

  // ── Redundancy axis (absolute values — DEFAULT is 0 so multiplicative would flatline) ──
  // Probe the active range of the "hold versatile workers in reserve" term.
  // Values aligned with SEMANTIC_SCALE.redundancy so the winner maps cleanly to an ordinal level.
  for (const r of [15, 50, 150, 400]) {
    out.push({ ...DEFAULT_WEIGHTS, redundancy: r });
  }

  // ── Resilience-preset joints — redundancy combined with the other levers that shape backups ──
  out.push({ ...DEFAULT_WEIGHTS, // J: resilience-lite (current v1 preset baseline)
    redundancy: 50, priority: 0.5, consistency: 10,
    bucket1Value: 2, bucket2Penalty: 300, bucket3Penalty: 1000,
  });
  out.push({ ...DEFAULT_WEIGHTS, // K: resilience-strong
    redundancy: 150, priority: 0.5, consistency: 20, flexibility: 5,
    bucket1Value: 0, bucket2Penalty: 400, bucket3Penalty: 1000,
  });
  out.push({ ...DEFAULT_WEIGHTS, // L: resilience-only (isolate the term's effect)
    redundancy: 150,
  });
  return out;
}

// Cost-awareness grid — centered on PRESETS.economique.
// Probes the wage-band-normalized cost term introduced in cpsat-solver.ts
// (coefficient = CA × hours × (0.5 − role-band position), signed). Magnitudes are
// ~30× smaller than the old absolute-€ formulation; the active range is higher.
export function costGrid(): WeightConfig[] {
  const base = PRESETS.economique;
  const out: WeightConfig[] = [];

  // Axis 1: costAwareness alone. CA=0 is the "no cost signal" control.
  // With signed wage-band (max per-assignment coeff ≈ CA × hours × 0.5), CA=100
  // produces ~250 at 5h — 25% of a typical fill reward — enough to shift picks
  // without dominating fill pressure. CA=1000 is well above any plausible ship value.
  for (const ca of [0, 50, 100, 200, 400, 1000]) {
    out.push({ ...base, costAwareness: ca });
  }

  return out;
}

export function fineGrid(center: WeightConfig, n: number): WeightConfig[] {
  // Random ±20% perturbations around `center`.
  const out: WeightConfig[] = [center];
  const rngSeed = 12345;
  let s = rngSeed >>> 0;
  const rng = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n - 1; i++) {
    const c: WeightConfig = { ...center };
    for (const k of Object.keys(c) as (keyof WeightConfig)[]) {
      const mult = 0.8 + rng() * 0.4;
      const v = (c[k] as number) * mult;
      if (k === "bucket2OtOffset" || k === "bucket3OtOffset") {
        (c[k] as number) = Math.max(0, Math.min(1, v));
      } else {
        (c[k] as number) = v;
      }
    }
    out.push(c);
  }
  return out;
}
