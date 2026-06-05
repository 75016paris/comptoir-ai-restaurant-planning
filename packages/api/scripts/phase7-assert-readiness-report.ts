import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectPhase7ReadinessReportFailures } from "../src/db/phase7-readiness-report.js";
import { PHASE7_READINESS_PREFLIGHT_VERSION } from "../src/db/phase7-readiness-preflight.js";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

const report = argValue("--report");
const expectedSnapshotDirectory = argValue("--expect-snapshot-dir");
const maxReportAgeMinutes = argValue("--max-report-age-minutes");
const expectedCountArgs = [
  { key: "ownerDatabases", flag: "--expect-owner-count", raw: argValue("--expect-owner-count") },
  { key: "restaurants", flag: "--expect-restaurant-count", raw: argValue("--expect-restaurant-count") },
  { key: "users", flag: "--expect-user-count", raw: argValue("--expect-user-count") },
  { key: "services", flag: "--expect-service-count", raw: argValue("--expect-service-count") },
  { key: "documents", flag: "--expect-document-count", raw: argValue("--expect-document-count") },
  { key: "notifications", flag: "--expect-notification-count", raw: argValue("--expect-notification-count") },
  { key: "chatMessages", flag: "--expect-chat-message-count", raw: argValue("--expect-chat-message-count") },
  { key: "cronRuns", flag: "--expect-cron-run-count", raw: argValue("--expect-cron-run-count") },
  { key: "totalDatabaseBytes", flag: "--expect-total-database-bytes", raw: argValue("--expect-total-database-bytes") },
] as const;
if (!report) {
  throw new Error("Usage: bun scripts/phase7-assert-readiness-report.ts --report <report-json-path> [--require-snapshot-dir] [--expect-snapshot-dir <snapshot-directory>] [--max-report-age-minutes <minutes>] [--expect-owner-count <count>] [--expect-restaurant-count <count>] [--expect-user-count <count>] [--expect-service-count <count>] [--expect-document-count <count>] [--expect-notification-count <count>] [--expect-chat-message-count <count>] [--expect-cron-run-count <count>] [--expect-total-database-bytes <bytes>]");
}

const reportPath = resolve(report);
let failures: string[];
let snapshotDirectory: string | null = null;
let snapshotSummary: Record<string, unknown> | null = null;
let generatedAt: string | null = null;
let actualReportVersion: unknown = null;

try {
  const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
  failures = collectPhase7ReadinessReportFailures(parsed);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    actualReportVersion = record.reportVersion ?? null;
    const directory = record.directory;
    snapshotDirectory = typeof directory === "string" ? directory : null;
    generatedAt = typeof record.generatedAt === "string" ? record.generatedAt : null;
    snapshotSummary = typeof record.snapshotSummary === "object" && record.snapshotSummary !== null && !Array.isArray(record.snapshotSummary)
      ? record.snapshotSummary as Record<string, unknown>
      : null;
  }
} catch (error) {
  failures = [`invalid_report_json:${error instanceof Error ? error.message : String(error)}`];
}

let maxReportAgeMs: number | null = null;
if (maxReportAgeMinutes !== null) {
  const minutes = Number(maxReportAgeMinutes);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`Invalid non-negative integer for --max-report-age-minutes: ${maxReportAgeMinutes}`);
  }
  maxReportAgeMs = minutes * 60 * 1000;
  if (!generatedAt) {
    failures.push("missing_generated_at_for_age_check");
  } else {
    const generatedAtMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedAtMs)) {
      failures.push(`invalid_generated_at_for_age_check:${generatedAt}`);
    } else {
      const ageMs = Date.now() - generatedAtMs;
      if (ageMs < 0) {
        failures.push(`future_report:${generatedAt}`);
      } else if (ageMs > maxReportAgeMs) {
        failures.push(`stale_report:${maxReportAgeMinutes}:${generatedAt}`);
      }
    }
  }
}

if (process.argv.includes("--require-snapshot-dir")) {
  if (!snapshotDirectory) {
    failures.push("missing_snapshot_directory");
  } else if (!existsSync(snapshotDirectory)) {
    failures.push(`missing_snapshot_directory:${snapshotDirectory}`);
  }
}

if (expectedSnapshotDirectory) {
  const expected = resolve(expectedSnapshotDirectory);
  if (!snapshotDirectory) {
    failures.push(`snapshot_directory_mismatch:${expected}:missing`);
  } else if (resolve(snapshotDirectory) !== expected) {
    failures.push(`snapshot_directory_mismatch:${expected}:${snapshotDirectory}`);
  }
}

const expectedSnapshotSummary: Record<string, number> = {};
for (const { key, flag, raw } of expectedCountArgs) {
  if (raw === null) continue;
  const expected = Number(raw);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`Invalid non-negative integer for ${flag}: ${raw}`);
  }
  expectedSnapshotSummary[key] = expected;
  const actual = snapshotSummary?.[key];
  if (actual !== expected) {
    failures.push(`snapshot_summary_mismatch:${key}:${expected}:${String(actual)}`);
  }
}

const result = {
  status: failures.length === 0 ? "pass" : "fail",
  reportPath,
  expectedReportVersion: PHASE7_READINESS_PREFLIGHT_VERSION,
  actualReportVersion,
  expectedSnapshotDirectory: expectedSnapshotDirectory ? resolve(expectedSnapshotDirectory) : null,
  maxReportAgeMinutes: maxReportAgeMinutes !== null ? Number(maxReportAgeMinutes) : null,
  expectedSnapshotSummary,
  generatedAt,
  actualSnapshotSummary: snapshotSummary,
  snapshotDirectory,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  throw new Error("Phase 7 readiness report assertion failed.");
}
