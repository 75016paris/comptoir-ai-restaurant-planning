/**
 * C9 (HCR-L3121-22) rolling-average freshness gate.
 *
 * C9 caps a worker's 12-week rolling average at 46h. The cap uses historical
 * `services` rows; when that history is incomplete (new restaurant, missing
 * backfill, freshly-hired worker), the cap is untrustworthy. This module
 * classifies each worker's history quality and exposes helpers the solvers
 * use to decide whether to apply, widen, or skip C9.
 *
 * Bucket thresholds are chosen so the buckets align with the task acceptance
 * criteria (10/12 → high, 6/12 → medium, 3/12 → low):
 *   - high   ≥ 9/12 (75 %)
 *   - medium ≥ 6/12 (50 %)
 *   - low    ≥ 3/12 (25 %)
 *   - none   < 3/12
 */

import { parseDateUTC } from "./scheduling.js";

export type C9Confidence = "high" | "medium" | "low" | "none";

/** Days a worker must have been hired for before C9 starts applying. */
export const C9_BOOTSTRAP_DAYS = 28; // 4 weeks

/**
 * Classify a worker's history: ratio of weeks with ≥1 service over the
 * 12-week trailing window.
 */
export function c9ConfidenceFromWeekCount(weeksWithData: number, windowSize = 12): C9Confidence {
  if (windowSize <= 0) return "none";
  const ratio = weeksWithData / windowSize;
  if (ratio >= 0.75) return "high";
  if (ratio >= 0.5) return "medium";
  if (ratio >= 0.25) return "low";
  return "none";
}

/**
 * Was this worker hired inside the C9 bootstrap window? When true, C9 must be
 * skipped regardless of stored history (records from a prior contract would be
 * misleading).
 */
export function isBootstrapWorker(
  hireDate: string | null | undefined,
  baseMonday: string,
): boolean {
  if (!hireDate) return false;
  const base = parseDateUTC(baseMonday).getTime();
  const hired = parseDateUTC(hireDate).getTime();
  if (Number.isNaN(base) || Number.isNaN(hired)) return false;
  const daysSince = Math.floor((base - hired) / (24 * 3600 * 1000));
  // Future hire dates (daysSince < 0) mean the worker hasn't started — skip
  // bootstrap; the gate falls through to history-based classification (which
  // will correctly report "none" since no service rows exist yet).
  if (daysSince < 0) return false;
  return daysSince < C9_BOOTSTRAP_DAYS;
}

/**
 * Gate decision for a single worker-week slice.
 *
 *   - `apply:false`    → omit the C9 constraint for this worker.
 *   - `apply:true`     → apply with the returned `capMultiplier` (1.0 normally,
 *                        1.10 for `low`).
 *
 * `reason` explains the decision in diagnostics.
 */
export type C9GateDecision = {
  apply: boolean;
  capMultiplier: number;
  confidence: C9Confidence;
  bootstrap: boolean;
  reason: "normal" | "widened" | "skipped-low-data" | "skipped-bootstrap" | "disabled";
};

/**
 * Decide how to apply C9 for a worker given freshness inputs.
 *
 * - If `enabled` is false (feature flag off) → always apply normally; confidence
 *   is still reported for diagnostics.
 * - If bootstrap → skip. Historical week count is noise for a freshly-hired worker.
 * - Otherwise → confidence bucket decides: high/medium apply normally,
 *   low widens cap by 10 %, none skips.
 */
export function c9GateDecision(opts: {
  weeksWithData: number;
  bootstrap: boolean;
  enabled: boolean;
  windowSize?: number;
}): C9GateDecision {
  const confidence = c9ConfidenceFromWeekCount(opts.weeksWithData, opts.windowSize ?? 12);
  if (!opts.enabled) {
    return { apply: true, capMultiplier: 1.0, confidence, bootstrap: opts.bootstrap, reason: "disabled" };
  }
  if (opts.bootstrap) {
    return { apply: false, capMultiplier: 1.0, confidence, bootstrap: true, reason: "skipped-bootstrap" };
  }
  if (confidence === "none") {
    return { apply: false, capMultiplier: 1.0, confidence, bootstrap: false, reason: "skipped-low-data" };
  }
  if (confidence === "low") {
    return { apply: true, capMultiplier: 1.10, confidence, bootstrap: false, reason: "widened" };
  }
  return { apply: true, capMultiplier: 1.0, confidence, bootstrap: false, reason: "normal" };
}

/** Read the freshness-gate feature flag. Default on; set `C9_FRESHNESS_GATE=0` to disable. */
export function c9FreshnessGateEnabled(): boolean {
  return process.env.C9_FRESHNESS_GATE !== "0";
}
