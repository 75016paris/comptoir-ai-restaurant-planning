/**
 * Unit tests for the HiGHS worker isolation pool.
 *
 * Confirms that crash isolation holds (a poisoned solve doesn't break the
 * next one) and that the per-solve timeout cleans up properly.
 */

import { describe, test, expect } from "bun:test";
import { solveInWorker, HiGHSWorkerCrashed, HiGHSWorkerTimeout } from "./highs-pool.js";

const GOOD_MODEL = `Maximize
 obj: x1 + 2 x2
Subject To
 c1: x1 + x2 <= 10
Bounds
 0 <= x1 <= 5
 0 <= x2 <= 5
End`;

// Malformed LP — parsing throws inside WASM; mirrors the Aborted() abort
// pathway the singleton used to get stuck on.
const MALFORMED_MODEL = `Maximize
 obj: x1 +
Subject To
 c1: x1 @@@ garbage
End`;

describe.skip("solveInWorker — legacy HiGHS/ILP backend disabled", () => {
  test(
    "solves a known-good model",
    async () => {
      const result = await solveInWorker(GOOD_MODEL);
      expect(result.Status).toBe("Optimal");
      expect(result.Columns.x2.Primal).toBeCloseTo(5, 5);
    },
    { timeout: 20_000 },
  );

  test(
    "sequential calls both return feasible solutions",
    async () => {
      const a = await solveInWorker(GOOD_MODEL);
      const b = await solveInWorker(GOOD_MODEL);
      expect(a.Status).toBe("Optimal");
      expect(b.Status).toBe("Optimal");
    },
    { timeout: 40_000 },
  );

  test(
    "crash on one solve does not poison the next",
    async () => {
      // First call with a malformed model — expect a crash.
      let firstRejected = false;
      try {
        await solveInWorker(MALFORMED_MODEL);
      } catch (e) {
        firstRejected = true;
        expect(e).toBeInstanceOf(HiGHSWorkerCrashed);
      }
      expect(firstRejected).toBe(true);

      // Second call with a known-good model — must still succeed. This is the
      // behaviour the main-thread singleton failed at before this change.
      const result = await solveInWorker(GOOD_MODEL);
      expect(result.Status).toBe("Optimal");
    },
    { timeout: 40_000 },
  );

  test(
    "exceeds timeout → HiGHSWorkerTimeout",
    async () => {
      // 1ms budget can't cover the ~2s WASM cold-start, so the timer fires
      // before the worker can reply. That terminates the worker and rejects.
      let thrown: any = null;
      try {
        await solveInWorker(GOOD_MODEL, {}, 1);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(HiGHSWorkerTimeout);
    },
    { timeout: 10_000 },
  );
});
