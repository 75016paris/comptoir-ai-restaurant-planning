import { Hono } from "hono";
import { getCircuitSnapshot, getSolverUrls } from "../utils/solver-circuit.js";
import { getFallbackRate7d, getSolveEventCount7d } from "../utils/solver-fallback.js";

export const healthSolverRoutes = new Hono();

/**
 * GET /health/solver
 * Returns per-URL circuit state and the 7-day fallback rate. Counters are
 * in-memory and reset on boot.
 */
healthSolverRoutes.get("/", (c) => {
  const snapshot = getCircuitSnapshot();
  // Include configured URLs even if they've never been called (empty stats).
  const configured = getSolverUrls();
  const seen = new Set(snapshot.map(s => s.url));
  for (const url of configured) {
    if (!seen.has(url)) {
      snapshot.push({
        url,
        circuitOpen: false,
        consecutiveFails: 0,
        totalCalls: 0,
        totalFails: 0,
        lastLatencyMs: null,
        openedUntil: null,
      });
    }
  }
  return c.json({
    urls: snapshot,
    fallbackRate7d: getFallbackRate7d(),
    solveEventCount7d: getSolveEventCount7d(),
  });
});
