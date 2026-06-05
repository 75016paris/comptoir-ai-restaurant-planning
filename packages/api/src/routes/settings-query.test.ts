import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-settings-query-test-")), "test.db");

const {
  filterStaffingRestrictionOverrides,
  filterStaffingWhatIfOverrides,
  parseStaffingAnalysisJsonParam,
  stripInternalStaffingWorkerLoadFields,
} = await import("./settings.js");

describe("staffing analysis query parsing", () => {
  test("malformed JSON query params are rejected before route logic", () => {
    expect(parseStaffingAnalysisJsonParam("contractOverrides", "{")).toEqual({ ok: false, error: "contractOverrides doit être un JSON valide" });
  });

  test("valid JSON query params are parsed", () => {
    expect(parseStaffingAnalysisJsonParam<Record<string, number>>("contractOverrides", '{"worker-1":39}')).toEqual({ ok: true, value: { "worker-1": 39 } });
  });

  test("what-if override maps keep only direct target workers", () => {
    const allowed = new Set(["worker-direct"]);

    expect(filterStaffingWhatIfOverrides({ "worker-direct": 39, "worker-shared": 24 }, allowed)).toEqual({ "worker-direct": 39 });
    expect(filterStaffingWhatIfOverrides({ "worker-shared": 24 }, allowed)).toBeUndefined();
  });

  test("restriction overrides keep only direct target workers", () => {
    const allowed = new Set(["worker-direct"]);

    expect(filterStaffingRestrictionOverrides(["worker-shared", "worker-direct"], allowed)).toEqual(["worker-direct"]);
    expect(filterStaffingRestrictionOverrides(["worker-shared"], allowed)).toBeUndefined();
  });

  test("staffing worker loads do not expose internal shared-worker source ids", () => {
    expect(stripInternalStaffingWorkerLoadFields({
      workerId: "worker-shared",
      workerName: "Shared Worker",
      employmentActionEligible: false,
      sharedFromRestaurantId: "source-restaurant",
    })).toEqual({
      workerId: "worker-shared",
      workerName: "Shared Worker",
      employmentActionEligible: false,
    });
  });
});
