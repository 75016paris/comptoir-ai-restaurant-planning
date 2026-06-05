import { describe, test, expect, afterEach } from "bun:test";
import {
  c9ConfidenceFromWeekCount,
  isBootstrapWorker,
  c9GateDecision,
  c9FreshnessGateEnabled,
} from "./c9-freshness.js";

describe("c9ConfidenceFromWeekCount", () => {
  test("12/12 → high", () => {
    expect(c9ConfidenceFromWeekCount(12)).toBe("high");
  });

  test("10/12 → high (task acceptance criterion)", () => {
    expect(c9ConfidenceFromWeekCount(10)).toBe("high");
  });

  test("9/12 → high at the boundary", () => {
    expect(c9ConfidenceFromWeekCount(9)).toBe("high");
  });

  test("8/12 → medium just below high", () => {
    expect(c9ConfidenceFromWeekCount(8)).toBe("medium");
  });

  test("6/12 → medium (task acceptance criterion)", () => {
    expect(c9ConfidenceFromWeekCount(6)).toBe("medium");
  });

  test("5/12 → low just below medium", () => {
    expect(c9ConfidenceFromWeekCount(5)).toBe("low");
  });

  test("3/12 → low (task acceptance criterion)", () => {
    expect(c9ConfidenceFromWeekCount(3)).toBe("low");
  });

  test("2/12 → none just below low", () => {
    expect(c9ConfidenceFromWeekCount(2)).toBe("none");
  });

  test("0/12 → none", () => {
    expect(c9ConfidenceFromWeekCount(0)).toBe("none");
  });

  test("windowSize=0 is treated as none (defensive)", () => {
    expect(c9ConfidenceFromWeekCount(0, 0)).toBe("none");
  });
});

describe("isBootstrapWorker", () => {
  test("no hire date → not bootstrap", () => {
    expect(isBootstrapWorker(null, "2026-04-20")).toBe(false);
    expect(isBootstrapWorker(undefined, "2026-04-20")).toBe(false);
  });

  test("hired today → bootstrap", () => {
    expect(isBootstrapWorker("2026-04-20", "2026-04-20")).toBe(true);
  });

  test("hired 27 days ago → bootstrap (inside 28-day window)", () => {
    // 2026-04-20 - 27 days = 2026-03-24
    expect(isBootstrapWorker("2026-03-24", "2026-04-20")).toBe(true);
  });

  test("hired 28 days ago → NOT bootstrap (at boundary)", () => {
    // 2026-04-20 - 28 days = 2026-03-23
    expect(isBootstrapWorker("2026-03-23", "2026-04-20")).toBe(false);
  });

  test("hired well in the past → not bootstrap", () => {
    expect(isBootstrapWorker("2024-01-01", "2026-04-20")).toBe(false);
  });

  test("hired in the future → not bootstrap (negative days)", () => {
    expect(isBootstrapWorker("2026-05-01", "2026-04-20")).toBe(false);
  });

  test("malformed dates → false, not throw", () => {
    expect(isBootstrapWorker("not-a-date", "2026-04-20")).toBe(false);
    expect(isBootstrapWorker("2026-04-20", "also-bad")).toBe(false);
  });

  test("DST transition spans exactly 28 days → not bootstrap", () => {
    // 2026-03-01 → 2026-03-29 crosses both US (Mar 8) and EU (Mar 29) DST
    // transitions. With local-time parsing the daysSince diff off-by-one'd
    // to 27 in DST-observing TZs, flipping the answer. UTC parsing fixes it.
    expect(isBootstrapWorker("2026-03-01", "2026-03-29")).toBe(false);
  });
});

describe("c9GateDecision", () => {
  test("bootstrap worker → skipped regardless of history", () => {
    const d = c9GateDecision({ weeksWithData: 12, bootstrap: true, enabled: true });
    expect(d.apply).toBe(false);
    expect(d.reason).toBe("skipped-bootstrap");
    expect(d.bootstrap).toBe(true);
  });

  test("high confidence, non-bootstrap → apply at normal cap", () => {
    const d = c9GateDecision({ weeksWithData: 11, bootstrap: false, enabled: true });
    expect(d.apply).toBe(true);
    expect(d.capMultiplier).toBe(1.0);
    expect(d.confidence).toBe("high");
    expect(d.reason).toBe("normal");
  });

  test("medium confidence → apply at normal cap", () => {
    const d = c9GateDecision({ weeksWithData: 7, bootstrap: false, enabled: true });
    expect(d.apply).toBe(true);
    expect(d.capMultiplier).toBe(1.0);
    expect(d.confidence).toBe("medium");
  });

  test("low confidence → apply with 1.10× widened cap", () => {
    const d = c9GateDecision({ weeksWithData: 4, bootstrap: false, enabled: true });
    expect(d.apply).toBe(true);
    expect(d.capMultiplier).toBeCloseTo(1.10, 5);
    expect(d.confidence).toBe("low");
    expect(d.reason).toBe("widened");
  });

  test("none confidence → skipped", () => {
    const d = c9GateDecision({ weeksWithData: 1, bootstrap: false, enabled: true });
    expect(d.apply).toBe(false);
    expect(d.confidence).toBe("none");
    expect(d.reason).toBe("skipped-low-data");
  });

  test("gate disabled → always applies normally, reason=disabled", () => {
    const d = c9GateDecision({ weeksWithData: 0, bootstrap: true, enabled: false });
    expect(d.apply).toBe(true);
    expect(d.capMultiplier).toBe(1.0);
    expect(d.reason).toBe("disabled");
  });
});

describe("c9FreshnessGateEnabled", () => {
  const prev = process.env.C9_FRESHNESS_GATE;
  afterEach(() => {
    if (prev === undefined) delete process.env.C9_FRESHNESS_GATE;
    else process.env.C9_FRESHNESS_GATE = prev;
  });

  test("default on (env unset)", () => {
    delete process.env.C9_FRESHNESS_GATE;
    expect(c9FreshnessGateEnabled()).toBe(true);
  });

  test("C9_FRESHNESS_GATE=0 disables", () => {
    process.env.C9_FRESHNESS_GATE = "0";
    expect(c9FreshnessGateEnabled()).toBe(false);
  });

  test("any other value treated as enabled", () => {
    process.env.C9_FRESHNESS_GATE = "1";
    expect(c9FreshnessGateEnabled()).toBe(true);
  });
});
