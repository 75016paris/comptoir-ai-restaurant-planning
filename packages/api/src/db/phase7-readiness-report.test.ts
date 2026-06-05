import { describe, expect, test } from "bun:test";
import { assertPhase7ReadinessReport, collectPhase7ReadinessReportFailures } from "./phase7-readiness-report";

const passingReport = {
  reportVersion: 2,
  generatedAt: "2026-05-25T20:00:00.000Z",
  status: "pass",
  directory: "/tmp/snapshot",
  dryRunFailures: [],
  splitSchemaIssues: 0,
  splitScopeGaps: 0,
  snapshotVerificationFailures: [],
  snapshotReportStatus: "pass",
  documentMoveCount: 2,
  documentIssueCount: 0,
  documentPlanIssueCount: 0,
  snapshotSummary: {
    ownerDatabases: 2,
    restaurants: 3,
    users: 12,
    services: 40,
    documents: 5,
    notifications: 1,
    chatMessages: 2,
    cronRuns: 3,
    totalDatabaseBytes: 123456,
  },
  failures: [],
};

describe("Phase 7 readiness report", () => {
  test("accepts a clean archived preflight report", () => {
    expect(collectPhase7ReadinessReportFailures(passingReport)).toEqual([]);
    expect(() => assertPhase7ReadinessReport(passingReport)).not.toThrow();
  });

  test("rejects reports with non-pass status or blocking counters", () => {
    expect(collectPhase7ReadinessReportFailures({
      ...passingReport,
      status: "fail",
      splitScopeGaps: 1,
      failures: ["split_scope:chat_messages:missing_context_kind:1"],
    })).toEqual([
      "status:fail",
      "failures:1",
      "splitScopeGaps:1",
    ]);
  });

  test("rejects older report versions", () => {
    expect(collectPhase7ReadinessReportFailures({
      ...passingReport,
      reportVersion: 1,
    })).toEqual([
      "invalid_report_version:1",
    ]);
  });

  test("rejects non-ISO generatedAt values", () => {
    expect(collectPhase7ReadinessReportFailures({
      ...passingReport,
      generatedAt: "May 25 2026",
    })).toEqual([
      "invalid_generated_at:May 25 2026",
    ]);
  });

  test("rejects malformed reports", () => {
    expect(collectPhase7ReadinessReportFailures({
      reportVersion: 999,
      generatedAt: "",
      status: "pass",
      directory: "",
      dryRunFailures: "nope",
      splitSchemaIssues: "0",
      splitScopeGaps: 0,
      snapshotVerificationFailures: [],
      snapshotReportStatus: "fail",
      documentMoveCount: -1,
      documentIssueCount: 0,
      documentPlanIssueCount: 0,
      snapshotSummary: {
        ownerDatabases: -1,
      },
      failures: [],
    })).toEqual([
      "invalid_report_version:999",
      "missing_generated_at",
      "missing_directory",
      "snapshot_report_status:fail",
      "invalid_snapshot_summary:ownerDatabases",
      "invalid_snapshot_summary:restaurants",
      "invalid_snapshot_summary:users",
      "invalid_snapshot_summary:services",
      "invalid_snapshot_summary:documents",
      "invalid_snapshot_summary:notifications",
      "invalid_snapshot_summary:chatMessages",
      "invalid_snapshot_summary:cronRuns",
      "invalid_snapshot_summary:totalDatabaseBytes",
      "invalid_array:dryRunFailures",
      "invalid_number:splitSchemaIssues",
      "invalid_number:documentMoveCount",
    ]);
  });

  test("rejects non-string failure arrays", () => {
    expect(collectPhase7ReadinessReportFailures({
      ...passingReport,
      failures: [123],
    })).toEqual([
      "invalid_array_items:failures",
    ]);
  });
});
