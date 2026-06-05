import { describe, expect, test } from "bun:test";
import { computeLaborCostSummary } from "./labor-cost.js";

describe("computeLaborCostSummary", () => {
  test("uses base hourly rate when weekly hours stay within 39h", () => {
    const result = computeLaborCostSummary([
      { workerId: "w1", date: "2026-05-11", startTime: "09:00", endTime: "17:00", rateCents: 1200 },
      { workerId: "w1", date: "2026-05-12", startTime: "09:00", endTime: "17:00", rateCents: 1200 },
    ]);

    expect(result.weekly).toBe(192);
    expect(result.daily["2026-05-11"]).toBe(96);
    expect(result.unpricedWorkerCount).toBe(0);
  });

  test("applies HCR overtime premiums after 39h per worker", () => {
    const result = computeLaborCostSummary([
      { workerId: "w1", date: "2026-05-11", startTime: "09:00", endTime: "17:00", rateCents: 1000 },
      { workerId: "w1", date: "2026-05-12", startTime: "09:00", endTime: "17:00", rateCents: 1000 },
      { workerId: "w1", date: "2026-05-13", startTime: "09:00", endTime: "17:00", rateCents: 1000 },
      { workerId: "w1", date: "2026-05-14", startTime: "09:00", endTime: "17:00", rateCents: 1000 },
      { workerId: "w1", date: "2026-05-15", startTime: "09:00", endTime: "17:00", rateCents: 1000 },
      { workerId: "w1", date: "2026-05-16", startTime: "09:00", endTime: "17:00", rateCents: 1000 },
    ]);

    // 39h × 10€ + 4h × 11€ + 4h × 12€ + 1h × 15€ = 497€.
    expect(result.weekly).toBe(497);
    // Saturday crosses all overtime bands: 3h × 11€ + 4h × 12€ + 1h × 15€.
    expect(result.daily["2026-05-16"]).toBe(96);
  });

  test("counts unpriced workers once and excludes them from cost", () => {
    const result = computeLaborCostSummary([
      { workerId: "w1", date: "2026-05-11", startTime: "09:00", endTime: "17:00", rateCents: null },
      { workerId: "w1", date: "2026-05-12", startTime: "09:00", endTime: "17:00", rateCents: null },
      { workerId: "w2", date: "2026-05-13", startTime: "09:00", endTime: "17:00", rateCents: 1500 },
    ]);

    expect(result.weekly).toBe(120);
    expect(result.unpricedWorkerCount).toBe(1);
  });
});
