/**
 * Retry + per-URL circuit breaker for the CP-SAT HTTP sidecar.
 *
 * One HTTP call can transiently fail (solver restart, network blip). We retry
 * up to 3 attempts with backoff, rotating URLs across a sidecar pool. A URL
 * with 3 consecutive failures is marked open for 30s and skipped.
 *
 * 4xx responses indicate a bad model (our fault) — fail fast, no retry.
 * 5xx / network errors / timeouts / body-parse failures are retried.
 */

import type { SolverRequest, SolverResponse } from "dabke";

export class CPSATBadModelError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CPSATBadModelError";
    this.status = status;
  }
}

export class CPSATUnreachableError extends Error {
  lastError?: Error;
  constructor(message: string, lastError?: Error) {
    super(message);
    this.name = "CPSATUnreachableError";
    this.lastError = lastError;
  }
}

type CircuitState = {
  consecutiveFails: number;
  /** ms-since-epoch when the circuit will close again, or null if closed. */
  openedUntil: number | null;
  totalFails: number;
  totalCalls: number;
  lastLatencyMs: number | null;
};

const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFFS_MS = [250, 750];

const circuits = new Map<string, CircuitState>();
let rrIdx = 0;

function getCircuit(url: string): CircuitState {
  let c = circuits.get(url);
  if (!c) {
    c = {
      consecutiveFails: 0,
      openedUntil: null,
      totalFails: 0,
      totalCalls: 0,
      lastLatencyMs: null,
    };
    circuits.set(url, c);
  }
  return c;
}

export function getSolverUrls(): string[] {
  const multi = process.env.CPSAT_SOLVER_URLS;
  if (multi) {
    const urls = multi.split(",").map(u => u.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }
  const single = process.env.CPSAT_SOLVER_URL;
  if (single) {
    const urls = single.split(",").map(u => u.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }
  return ["http://localhost:8090"];
}

function selectUrl(urls: string[]): string {
  const now = Date.now();
  const closed: string[] = [];
  for (const u of urls) {
    const c = circuits.get(u);
    if (!c || c.openedUntil === null || c.openedUntil <= now) closed.push(u);
  }
  if (closed.length > 0) {
    return closed[rrIdx++ % closed.length];
  }
  // All circuits open — fall back to the least-recently-opened one
  // (smallest openedUntil = opened longest ago).
  let best = urls[0];
  let bestUntil = Number.POSITIVE_INFINITY;
  for (const u of urls) {
    const c = circuits.get(u);
    const until = c?.openedUntil ?? 0;
    if (until < bestUntil) {
      bestUntil = until;
      best = u;
    }
  }
  return best;
}

function recordSuccess(url: string, latencyMs: number) {
  const c = getCircuit(url);
  c.consecutiveFails = 0;
  c.openedUntil = null;
  c.lastLatencyMs = latencyMs;
  c.totalCalls++;
}

function recordFailure(url: string, latencyMs: number) {
  const c = getCircuit(url);
  c.consecutiveFails++;
  c.totalFails++;
  c.totalCalls++;
  c.lastLatencyMs = latencyMs;
  if (c.consecutiveFails >= CIRCUIT_FAIL_THRESHOLD) {
    c.openedUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * POST `request` to the CP-SAT sidecar with retry + circuit-breaker routing.
 *
 * Throws `CPSATBadModelError` immediately on HTTP 4xx (do not retry).
 * Throws `CPSATUnreachableError` when all attempts fail.
 */
export async function callSolverWithRetry(
  request: SolverRequest,
  options: { timeoutMs?: number; urls?: string[] } = {},
): Promise<SolverResponse> {
  const urls = options.urls ?? getSolverUrls();
  const timeoutMs = options.timeoutMs ?? Number(process.env.CPSAT_HTTP_TIMEOUT_MS || 60_000);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // ±20% jitter so N parallel callers don't retry in lockstep and thunder
      // the sidecar the moment it recovers.
      const base = BACKOFFS_MS[attempt - 1];
      await sleep(base * (0.8 + 0.4 * Math.random()));
    }
    const url = selectUrl(urls);
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status >= 400 && res.status < 500) {
        const detail = await res.text().catch(() => "");
        // Bad model is our bug; do not retry and do not trip the circuit.
        throw new CPSATBadModelError(
          `CP-SAT bad model ${res.status}: ${detail}`,
          res.status,
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`CP-SAT HTTP ${res.status}: ${detail}`);
        (err as any).httpStatus = res.status;
        throw err;
      }
      let parsed: SolverResponse;
      try {
        parsed = (await res.json()) as SolverResponse;
      } catch (e: any) {
        throw new Error(`CP-SAT body parse failed: ${e?.message || e}`);
      }
      const latency = performance.now() - start;
      recordSuccess(url, latency);
      return parsed;
    } catch (e: any) {
      clearTimeout(timer);
      const latency = performance.now() - start;
      if (e instanceof CPSATBadModelError) throw e;
      recordFailure(url, latency);
      lastError = e;
    }
  }

  throw new CPSATUnreachableError(
    `CP-SAT unreachable after ${MAX_ATTEMPTS} attempts: ${lastError?.message || "unknown"}`,
    lastError,
  );
}

// ── Introspection (for /health/solver and tests) ──

export function getCircuitSnapshot(): Array<{
  url: string;
  circuitOpen: boolean;
  consecutiveFails: number;
  totalCalls: number;
  totalFails: number;
  lastLatencyMs: number | null;
  openedUntil: number | null;
}> {
  const now = Date.now();
  return Array.from(circuits.entries()).map(([url, c]) => ({
    url,
    circuitOpen: c.openedUntil !== null && c.openedUntil > now,
    consecutiveFails: c.consecutiveFails,
    totalCalls: c.totalCalls,
    totalFails: c.totalFails,
    lastLatencyMs: c.lastLatencyMs,
    openedUntil: c.openedUntil,
  }));
}

/** Test-only: reset all in-memory circuit state. */
export function __resetCircuitState() {
  circuits.clear();
  rrIdx = 0;
}
