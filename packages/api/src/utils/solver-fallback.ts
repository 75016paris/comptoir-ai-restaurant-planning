/**
 * Cross-solver fallback wrapper: CP-SAT first, ILP on definitive failure.
 *
 * "Definitive failure" = all retries exhausted and all URLs circuit-open,
 * surfaced as a thrown CPSATUnreachableError from solveCPSAT. Bad-model
 * errors (4xx) are NOT fallback-eligible — they'd just fail the same way
 * against ILP.
 *
 * Callers get the same ILPResult shape plus a `solverUsed` tag.
 *
 * ── ILP parity gap (audit restructure step C, 2026-04-23) ───────────────
 * ILP is a feature-frozen safety net, not a feature-equivalent backend.
 * The ILP fallback returns baseline behaviour without these CP-SAT-only
 * features — callers that hit fallback silently forfeit them:
 *
 *   - `templateMatch` objective term for dow stability (équipe-stable
 *     preset). Driven by the `dowTemplates` parameter; ILP never receives
 *     it (see fallback call site below). cpsat-solver.ts ~line 321.
 *   - `AddHint` warm-start. Driven by the `hints` parameter; ILP signature
 *     accepts and discards (see ilp-solver.ts `_hints` underscore prefix).
 *     HiGHS supports MIP starts but wiring is explicitly out of scope per
 *     audit M12.
 *   - Determinism controls: `CPSAT_RANDOM_SEED`, `CPSAT_NUM_WORKERS`,
 *     `max_deterministic_time`. CP-SAT sidecar only.
 *   - Structured infeasibility reasons and top-level `objectiveValue`
 *     field — populated by CP-SAT path only; ILP result has neither.
 *
 * If a new CP-SAT objective term or constraint lands, add it here rather
 * than porting it to HiGHS. The fallback path must stay narrow and boring.
 *
 * ── solveILP direct callers (audit restructure step B, 2026-04-23) ──────
 * Production invariant: `solveWithFallback` is the only entry point to
 * `solveILP` on the production path. The direct callers below are all
 * diagnostics gated by `SOLVER_DIAG=1` (default off) — they cannot be
 * routed through this wrapper because their diagnostic semantic requires
 * bypassing fallback. Enumerated explicitly so a reader doesn't have to
 * re-derive why each one stayed direct:
 *
 *   - services/multi-week-solver.ts:357 — SOLVER=ilp|highs backend force.
 *     The wrapper tries CP-SAT first; routing through it defeats the
 *     "force ILP" semantic. Adding a force-backend param would be scope
 *     creep into a new feature.
 *   - services/multi-week-solver.ts:372 — CPSAT_COMPARE=1 alt-solve.
 *     This IS the cross-backend comparison — must hit each backend
 *     directly or the delta it logs is meaningless.
 *   - routes/autostaffing.ts:1406 — SOLVER=ilp|highs backend force in
 *     single-week path. Same reason as multi-week-solver.ts:357.
 *
 * Tests (`solver-role-cap-diagnostic.test.ts`, `c9-gate.test.ts`,
 * `solver-parity.test.ts`) also call `solveILP` directly; test seams are
 * legitimately outside this invariant.
 */

import type {
  ILPResult,
  ILPWorker,
  ILPSlot,
  ILPConfig,
  AvailabilityChecker,
  MultiWeekConfig,
  SlotFillFloors,
} from "./ilp-solver.js";
import { solveILP } from "./ilp-solver.js";
import { solveCPSAT } from "./cpsat-solver.js";
import { CPSATUnreachableError } from "./solver-circuit.js";
import type { HintAssignment } from "../services/hint-store.js";
import { DEFAULT_WEIGHTS, type WeightConfig } from "@comptoir/shared";

type SolverFn = typeof solveCPSAT;

/**
 * Indirection so tests can substitute stub solvers without monkey-patching modules.
 * Production code never mutates these fields.
 */
export const solverFns: { cpsat: SolverFn; ilp: SolverFn } = {
  cpsat: solveCPSAT,
  ilp: solveILP,
};

type SolveEvent = { ts: number; used: "cpsat" | "ilp-fallback" };
const solveEvents: SolveEvent[] = [];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function recordSolveEvent(used: SolveEvent["used"]) {
  const now = Date.now();
  solveEvents.push({ ts: now, used });
  const cutoff = now - SEVEN_DAYS_MS;
  while (solveEvents.length > 0 && solveEvents[0].ts < cutoff) solveEvents.shift();
}

export function getFallbackRate7d(): number {
  const now = Date.now();
  const cutoff = now - SEVEN_DAYS_MS;
  let total = 0;
  let fallbacks = 0;
  for (const e of solveEvents) {
    if (e.ts < cutoff) continue;
    total++;
    if (e.used === "ilp-fallback") fallbacks++;
  }
  if (total === 0) return 0;
  return fallbacks / total;
}

export function getSolveEventCount7d(): number {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return solveEvents.filter(e => e.ts >= cutoff).length;
}

/** Test-only: drop tracked events. */
export function __resetSolveEvents() {
  solveEvents.length = 0;
}

/**
 * Master switch for diagnostic solver opt-outs. Gates `SOLVER=ilp|highs` and
 * `CPSAT_COMPARE=1` — both are diagnostic-only and bypass the CP-SAT→ILP
 * fallback wrapper. With `SOLVER_DIAG` unset (the default), those env vars
 * are ignored and production runs the CP-SAT-with-fallback path unconditionally;
 * set `SOLVER_DIAG=1` (or `true`) to re-enable them. Signature mirrors
 * `templateMatchEnabled()` in `services/dow-template.ts`.
 */
export function solverDiagEnabled(): boolean {
  const v = process.env.SOLVER_DIAG;
  return v === "1" || v === "true";
}

/**
 * Gate for the cross-backend parity suite (`solver-parity.test.ts`). ILP is
 * feature-frozen (audit restructure step C) and the parity tests only cover
 * dimensions both backends implement — so they serve as a diagnostic, not a
 * default-suite invariant. Default OFF so `bun test` skips them and a
 * CP-SAT-only change can't fail the suite on an intentional parity gap
 * (templateMatch, AddHint, determinism controls — see this file's header).
 * Enable with `SOLVER_PARITY_TESTS=1` (also accepts `true`) when explicitly
 * auditing equivalence on the shared feature surface. Signature mirrors
 * `solverDiagEnabled()` and `templateMatchEnabled()`.
 */
export function parityTestsEnabled(): boolean {
  const v = process.env.SOLVER_PARITY_TESTS;
  return v === "1" || v === "true";
}

/**
 * Primary entry point. Callers replace bare `solveCPSAT()` with this wrapper.
 *
 * Disable fallback with `SOLVER_FALLBACK_ENABLED=0` — the thrown unreachable
 * error propagates unchanged.
 */
export async function solveWithFallback(
  workers: ILPWorker[],
  slots: ILPSlot[],
  config: ILPConfig,
  checker: AvailabilityChecker,
  multiWeek?: MultiWeekConfig,
  slotFillFloors?: SlotFillFloors,
  weights: WeightConfig = DEFAULT_WEIGHTS,
  hints?: HintAssignment[],
  dowTemplates?: Map<string, Set<number>>,
): Promise<ILPResult> {
  const fallbackEnabled = process.env.SOLVER_FALLBACK_ENABLED !== "0";
  try {
    const result = await solverFns.cpsat(
      workers, slots, config, checker, multiWeek, slotFillFloors, weights, hints, dowTemplates,
    );
    recordSolveEvent("cpsat");
    return { ...result, solverUsed: "cpsat" };
  } catch (e: any) {
    const isUnreachable =
      e instanceof CPSATUnreachableError || e?.name === "CPSATUnreachableError";
    if (!isUnreachable || !fallbackEnabled) throw e;
    console.warn(
      `[solver-fallback] CP-SAT unreachable, falling back to ILP: ${e?.message || e}`,
    );
    // ILP is feature-frozen per audit restructure step C. Drop dowTemplates
    // (no templateMatch impl in ILP) and the hints signature-slot goes
    // unused (ilp-solver.ts accepts `_hints` and discards). See this file's
    // header for the full parity-gap list.
    const result = await solverFns.ilp(
      workers, slots, config, checker, multiWeek, slotFillFloors, weights,
    );
    recordSolveEvent("ilp-fallback");
    return { ...result, solverUsed: "ilp-fallback" };
  }
}
