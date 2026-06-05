import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-multi-week-test-")), "test.db");

const { computeOtCapacity } = await import("./multi-week-solver.js");

describe("computeOtCapacity", () => {
  test("uses per-worker max weekly overrides when present", () => {
    expect(computeOtCapacity([{ contractHours: 35, maxWeeklyHours: 46 }], "strict", 39)).toBe(11);
  });
});
