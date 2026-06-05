import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const cleanReport = {
  reportVersion: 2,
  generatedAt: "2026-05-25T20:00:00.000Z",
  status: "pass",
  directory: "/tmp/snapshot",
  dryRunFailures: [],
  splitSchemaIssues: 0,
  splitScopeGaps: 0,
  snapshotVerificationFailures: [],
  snapshotReportStatus: "pass",
  documentMoveCount: 0,
  documentIssueCount: 0,
  documentPlanIssueCount: 0,
  snapshotSummary: {
    ownerDatabases: 1,
    restaurants: 1,
    users: 1,
    services: 0,
    documents: 0,
    notifications: 0,
    chatMessages: 0,
    cronRuns: 0,
    totalDatabaseBytes: 8192,
  },
  failures: [],
};

function writeReport(name: string, report: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-report-assert-"));
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function runAssertReport(reportPath: string, extraArgs: string[] = []) {
  return Bun.spawnSync({
    cmd: ["bun", "scripts/phase7-assert-readiness-report.ts", "--report", reportPath, ...extraArgs],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runAssertReportArgs(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "scripts/phase7-assert-readiness-report.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("phase7 readiness report assertion CLI", () => {
  test("passes for a clean archived report", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReport(reportPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"status": "pass"');
    expect(result.stdout.toString()).toContain('"expectedReportVersion": 2');
    expect(result.stdout.toString()).toContain('"actualReportVersion": 2');
    expect(result.stdout.toString()).toContain('"generatedAt": "2026-05-25T20:00:00.000Z"');
    expect(result.stdout.toString()).toContain('"actualSnapshotSummary": {');
    expect(result.stdout.toString()).toContain('"snapshotDirectory": "/tmp/snapshot"');
    expect(result.stdout.toString()).toContain('"failures": []');
  });

  test("can require the referenced snapshot directory to exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-report-assert-"));
    const snapshotDirectory = join(dir, "snapshot");
    mkdirSync(snapshotDirectory);
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      directory: snapshotDirectory,
    });

    const result = runAssertReport(reportPath, ["--require-snapshot-dir"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"status": "pass"');
    expect(result.stdout.toString()).toContain(`"snapshotDirectory": "${snapshotDirectory}"`);
  });

  test("can require the referenced snapshot directory to match an expected path", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-report-assert-"));
    const snapshotDirectory = join(dir, "snapshot");
    mkdirSync(snapshotDirectory);
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      directory: snapshotDirectory,
    });

    const result = runAssertReport(reportPath, [
      "--require-snapshot-dir",
      "--expect-snapshot-dir",
      snapshotDirectory,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`"expectedSnapshotDirectory": "${snapshotDirectory}"`);
    expect(result.stdout.toString()).toContain(`"snapshotDirectory": "${snapshotDirectory}"`);
  });

  test("can require expected snapshot summary counts", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReport(reportPath, [
      "--expect-owner-count",
      "1",
      "--expect-restaurant-count",
      "1",
      "--expect-user-count",
      "1",
      "--expect-service-count",
      "0",
      "--expect-document-count",
      "0",
      "--expect-notification-count",
      "0",
      "--expect-chat-message-count",
      "0",
      "--expect-cron-run-count",
      "0",
      "--expect-total-database-bytes",
      "8192",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"expectedSnapshotSummary": {');
    expect(result.stdout.toString()).toContain('"ownerDatabases": 1');
    expect(result.stdout.toString()).toContain('"services": 0');
    expect(result.stdout.toString()).toContain('"chatMessages": 0');
    expect(result.stdout.toString()).toContain('"totalDatabaseBytes": 8192');
  });

  test("prints the actual version for older archived reports", () => {
    const reportPath = writeReport("old.json", {
      ...cleanReport,
      reportVersion: 1,
    });

    const result = runAssertReport(reportPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain('"expectedReportVersion": 2');
    expect(result.stdout.toString()).toContain('"actualReportVersion": 1');
    expect(result.stdout.toString()).toContain('"invalid_report_version:1"');
  });

  test("can require a fresh report", () => {
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      generatedAt: new Date().toISOString(),
    });

    const result = runAssertReport(reportPath, [
      "--max-report-age-minutes",
      "5",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"status": "pass"');
    expect(result.stdout.toString()).toContain('"maxReportAgeMinutes": 5');
  });

  test("fails when the report is older than the allowed age", () => {
    const generatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      generatedAt,
    });

    const result = runAssertReport(reportPath, [
      "--max-report-age-minutes",
      "1",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain(`"stale_report:1:${generatedAt}"`);
  });

  test("fails when the report timestamp is in the future", () => {
    const generatedAt = new Date(Date.now() + 60 * 1000).toISOString();
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      generatedAt,
    });

    const result = runAssertReport(reportPath, [
      "--max-report-age-minutes",
      "5",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain(`"future_report:${generatedAt}"`);
  });

  test("fails when expected snapshot summary counts do not match", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReport(reportPath, [
      "--expect-service-count",
      "7",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain('"snapshot_summary_mismatch:services:7:0"');
  });

  test("fails when expected split snapshot counts do not match", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReport(reportPath, [
      "--expect-chat-message-count",
      "2",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain('"snapshot_summary_mismatch:chatMessages:2:0"');
  });

  test("fails when the expected snapshot byte total does not match", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReport(reportPath, [
      "--expect-total-database-bytes",
      "16384",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain('"snapshot_summary_mismatch:totalDatabaseBytes:16384:8192"');
  });

  test("fails when the referenced snapshot directory does not match the expected path", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-report-assert-"));
    const snapshotDirectory = join(dir, "snapshot");
    const expectedSnapshotDirectory = join(dir, "expected-snapshot");
    mkdirSync(snapshotDirectory);
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      directory: snapshotDirectory,
    });

    const result = runAssertReport(reportPath, [
      "--expect-snapshot-dir",
      expectedSnapshotDirectory,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain(`"snapshot_directory_mismatch:${expectedSnapshotDirectory}:${snapshotDirectory}"`);
  });

  test("rejects missing option values", () => {
    const result = runAssertReportArgs(["--report", "--expect-snapshot-dir", "/tmp/snapshot"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Missing value for --report");
  });

  test("rejects missing expected snapshot directory value", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReportArgs(["--report", reportPath, "--expect-snapshot-dir"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Missing value for --expect-snapshot-dir");
  });

  test("rejects missing expected count values", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReportArgs(["--report", reportPath, "--expect-service-count"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Missing value for --expect-service-count");
  });

  test("rejects missing max report age values", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReportArgs(["--report", reportPath, "--max-report-age-minutes"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Missing value for --max-report-age-minutes");
  });

  test("rejects invalid expected count values", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReportArgs(["--report", reportPath, "--expect-user-count", "nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid non-negative integer for --expect-user-count: nope");
  });

  test("rejects invalid expected byte total values", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReportArgs(["--report", reportPath, "--expect-total-database-bytes", "-1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid non-negative integer for --expect-total-database-bytes: -1");
  });

  test("rejects invalid max report age values", () => {
    const reportPath = writeReport("pass.json", cleanReport);

    const result = runAssertReportArgs(["--report", reportPath, "--max-report-age-minutes", "nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid non-negative integer for --max-report-age-minutes: nope");
  });

  test("fails when required snapshot directory is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-report-assert-"));
    const snapshotDirectory = join(dir, "missing-snapshot");
    const reportPath = writeReport("pass.json", {
      ...cleanReport,
      directory: snapshotDirectory,
    });

    const result = runAssertReport(reportPath, ["--require-snapshot-dir"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain(`"missing_snapshot_directory:${snapshotDirectory}"`);
  });

  test("fails for a report with blocking issues", () => {
    const reportPath = writeReport("fail.json", {
      ...cleanReport,
      status: "fail",
      splitScopeGaps: 1,
      failures: ["split_scope:notifications:missing_owner_id:1"],
    });

    const result = runAssertReport(reportPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain('"splitScopeGaps:1"');
    expect(result.stderr.toString()).toContain("Phase 7 readiness report assertion failed.");
  });

  test("prints a machine-readable failure for invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-report-assert-"));
    const reportPath = join(dir, "broken.json");
    writeFileSync(reportPath, "{broken json\n");

    const result = runAssertReport(reportPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('"status": "fail"');
    expect(result.stdout.toString()).toContain('"invalid_report_json:');
    expect(result.stderr.toString()).toContain("Phase 7 readiness report assertion failed.");
  });
});
