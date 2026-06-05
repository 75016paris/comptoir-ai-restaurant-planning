import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  callSolverWithRetry,
  CPSATBadModelError,
  CPSATUnreachableError,
  getCircuitSnapshot,
  __resetCircuitState,
} from "./solver-circuit.js";

// ── fetch stub ──
// One global stub — per-test handlers set `responder` to shape the reply based
// on URL. Returning (or throwing) here drives all retry/circuit paths.

const origFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string }> = [];
type Responder = (url: string) => Response | Promise<Response>;
let responder: Responder = () => new Response("{}", { status: 200 });

function stubFetch() {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    fetchCalls.push({ url });
    return await responder(url);
  }) as typeof fetch;
}

function okResponse(body: any = { status: "OPTIMAL", values: {} }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function serverErrorResponse(status = 503) {
  return new Response("boom", { status });
}

function clientErrorResponse(status = 400) {
  return new Response("bad model", { status });
}

const minimalRequest = {
  variables: [],
  constraints: [],
  objective: { sense: "maximize" as const, terms: [] },
  options: { timeLimitSeconds: 1 },
};

beforeEach(() => {
  __resetCircuitState();
  fetchCalls = [];
  responder = () => okResponse();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ── Retry semantics ──

describe("callSolverWithRetry", () => {
  test("succeeds on first attempt without retrying", async () => {
    responder = () => okResponse();
    const res = await callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 });
    expect(res).toEqual({ status: "OPTIMAL", values: {} });
    expect(fetchCalls.length).toBe(1);
  });

  test("retries on 503 and succeeds on attempt 2", async () => {
    let n = 0;
    responder = () => {
      n++;
      return n === 1 ? serverErrorResponse() : okResponse();
    };
    const res = await callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 });
    expect(res).toEqual({ status: "OPTIMAL", values: {} });
    expect(fetchCalls.length).toBe(2);
  });

  test("does not retry on HTTP 400 (bad model) — single attempt, CPSATBadModelError", async () => {
    responder = () => clientErrorResponse(400);
    await expect(
      callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CPSATBadModelError);
    expect(fetchCalls.length).toBe(1);
  });

  test("throws CPSATUnreachableError after 3 failed attempts", async () => {
    responder = () => serverErrorResponse();
    await expect(
      callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CPSATUnreachableError);
    expect(fetchCalls.length).toBe(3);
  });

  test("retries on body-parse failure", async () => {
    let n = 0;
    responder = () => {
      n++;
      if (n === 1) {
        return new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return okResponse();
    };
    const res = await callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 });
    expect(res).toEqual({ status: "OPTIMAL", values: {} });
    expect(fetchCalls.length).toBe(2);
  });
});

// ── Circuit breaker ──

describe("per-URL circuit breaker", () => {
  test("opens after 3 consecutive failures", async () => {
    // 3 consecutive 503 → circuit should open for url A
    responder = () => serverErrorResponse();
    await expect(
      callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CPSATUnreachableError);
    const snap = getCircuitSnapshot();
    const a = snap.find(s => s.url === "http://a")!;
    expect(a.circuitOpen).toBe(true);
    expect(a.consecutiveFails).toBe(3);
  });

  test("successful calls reset consecutiveFails", async () => {
    let n = 0;
    responder = () => (++n <= 2 ? serverErrorResponse() : okResponse());
    await callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 });
    const snap = getCircuitSnapshot();
    const a = snap.find(s => s.url === "http://a")!;
    expect(a.circuitOpen).toBe(false);
    expect(a.consecutiveFails).toBe(0);
  });

  test("routes to URL B when URL A circuit is open", async () => {
    // Pre-open A by calling it 3 times with 503
    responder = (url) => (url.startsWith("http://a") ? serverErrorResponse() : okResponse());
    await expect(
      callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CPSATUnreachableError);
    expect(getCircuitSnapshot().find(s => s.url === "http://a")!.circuitOpen).toBe(true);

    // Now call with both URLs — A is open, so it should go to B and succeed.
    fetchCalls = [];
    const res = await callSolverWithRetry(minimalRequest, {
      urls: ["http://a", "http://b"],
      timeoutMs: 1000,
    });
    expect(res).toEqual({ status: "OPTIMAL", values: {} });
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url.startsWith("http://b")).toBe(true);
  });

  test("4xx does not trip the circuit", async () => {
    responder = () => clientErrorResponse(400);
    await expect(
      callSolverWithRetry(minimalRequest, { urls: ["http://a"], timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CPSATBadModelError);
    const snap = getCircuitSnapshot();
    // No circuit entry was recorded because we don't record-fail on 4xx.
    const a = snap.find(s => s.url === "http://a");
    expect(a?.circuitOpen ?? false).toBe(false);
    expect(a?.consecutiveFails ?? 0).toBe(0);
  });
});
