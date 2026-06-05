import { describe, test, expect, afterEach } from "bun:test";
import {
  dowTemplatesFromRows,
  templateMatchEnabled,
  type ServiceRow,
} from "./dow-template";

// The DB-backed `deriveDowTemplates` is a thin wrapper (select + where);
// this suite covers the pure transform (dow extraction + dedup across weeks
// + multi-worker aggregation) and the env-flag helper. End-to-end coverage
// of the DB query sits with the multi-week-solver / autostaffing integration
// paths that invoke `deriveDowTemplates`.

function row(workerId: string, date: string): ServiceRow {
  return { workerId, date };
}

describe("dowTemplatesFromRows", () => {
  test("empty input → empty map", () => {
    expect(dowTemplatesFromRows([]).size).toBe(0);
  });

  test("single row → worker maps to that dow (ISO 1=Mon..7=Sun)", () => {
    // 2026-04-21 is Tuesday → ISO dow 2.
    const out = dowTemplatesFromRows([row("w1", "2026-04-21")]);
    expect(out.size).toBe(1);
    expect(out.get("w1")).toEqual(new Set([2]));
  });

  test("dedup across weeks — same worker + same dow on different dates → one entry", () => {
    // Three Tuesdays across three weeks.
    const out = dowTemplatesFromRows([
      row("w1", "2026-04-07"),
      row("w1", "2026-04-14"),
      row("w1", "2026-04-21"),
    ]);
    expect(out.get("w1")).toEqual(new Set([2]));
  });

  test("multiple distinct dows for one worker → all collected", () => {
    const out = dowTemplatesFromRows([
      row("w1", "2026-04-20"), // Mon
      row("w1", "2026-04-21"), // Tue
      row("w1", "2026-04-23"), // Thu
      row("w1", "2026-04-26"), // Sun
    ]);
    expect(out.get("w1")).toEqual(new Set([1, 2, 4, 7]));
  });

  test("multiple workers accumulate independently", () => {
    const out = dowTemplatesFromRows([
      row("w1", "2026-04-21"), // Tue
      row("w2", "2026-04-23"), // Thu
      row("w1", "2026-04-28"), // Tue (dedup)
      row("w2", "2026-04-25"), // Sat
    ]);
    expect(out.size).toBe(2);
    expect(out.get("w1")).toEqual(new Set([2]));
    expect(out.get("w2")).toEqual(new Set([4, 6]));
  });

  test("Sunday encoded as ISO 7 (not 0) — contract with slot.dow from isoDayOfWeek", () => {
    // 2026-04-26 is Sunday. Matters because `cpsat-solver.ts` compares
    // template.has(slot.dow) where slot.dow comes from isoDayOfWeek()
    // (1..7). If we returned 0 for Sunday, Sunday services would silently
    // miss the objective bump.
    const out = dowTemplatesFromRows([row("w1", "2026-04-26")]);
    expect(out.get("w1")).toEqual(new Set([7]));
  });
});

describe("templateMatchEnabled", () => {
  const original = process.env.TEMPLATE_MATCH_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.TEMPLATE_MATCH_ENABLED;
    else process.env.TEMPLATE_MATCH_ENABLED = original;
  });

  test("unset → on (default production behaviour)", () => {
    delete process.env.TEMPLATE_MATCH_ENABLED;
    expect(templateMatchEnabled()).toBe(true);
  });

  test('"1" → on (explicit-on, no-op vs unset)', () => {
    process.env.TEMPLATE_MATCH_ENABLED = "1";
    expect(templateMatchEnabled()).toBe(true);
  });

  test('"true" → on (explicit-on, no-op vs unset)', () => {
    process.env.TEMPLATE_MATCH_ENABLED = "true";
    expect(templateMatchEnabled()).toBe(true);
  });

  test('"0" → off (emergency rollback)', () => {
    process.env.TEMPLATE_MATCH_ENABLED = "0";
    expect(templateMatchEnabled()).toBe(false);
  });

  test('"false" → off (emergency rollback)', () => {
    process.env.TEMPLATE_MATCH_ENABLED = "false";
    expect(templateMatchEnabled()).toBe(false);
  });

  test('"" → on (empty string is unset-like under the new contract)', () => {
    process.env.TEMPLATE_MATCH_ENABLED = "";
    expect(templateMatchEnabled()).toBe(true);
  });
});
