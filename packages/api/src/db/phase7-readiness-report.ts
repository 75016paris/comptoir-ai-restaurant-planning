import { PHASE7_READINESS_PREFLIGHT_VERSION, type Phase7ReadinessPreflight } from "./phase7-readiness-preflight";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : null;
}

function invalidStringArray(value: unknown) {
  if (!Array.isArray(value)) return true;
  return value.some((item) => typeof item !== "string");
}

function nonNegativeNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isIsoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function pushInvalidSnapshotSummary(failures: string[], value: unknown) {
  if (!isRecord(value)) {
    failures.push("invalid_snapshot_summary");
    return;
  }

  for (const key of [
    "ownerDatabases",
    "restaurants",
    "users",
    "services",
    "documents",
    "notifications",
    "chatMessages",
    "cronRuns",
    "totalDatabaseBytes",
  ] as const) {
    if (nonNegativeNumberValue(value[key]) === null) {
      failures.push(`invalid_snapshot_summary:${key}`);
    }
  }
}

export function collectPhase7ReadinessReportFailures(report: unknown): string[] {
  if (!isRecord(report)) {
    return ["invalid_report_shape"];
  }

  const failures: string[] = [];

  if (report.reportVersion !== PHASE7_READINESS_PREFLIGHT_VERSION) {
    failures.push(`invalid_report_version:${String(report.reportVersion)}`);
  }

  if (typeof report.generatedAt !== "string" || report.generatedAt.length === 0) {
    failures.push("missing_generated_at");
  } else if (!isIsoTimestamp(report.generatedAt)) {
    failures.push(`invalid_generated_at:${report.generatedAt}`);
  }

  if (typeof report.directory !== "string" || report.directory.length === 0) {
    failures.push("missing_directory");
  }

  if (report.status !== "pass") {
    failures.push(`status:${String(report.status)}`);
  }

  if (report.snapshotReportStatus !== "pass") {
    failures.push(`snapshot_report_status:${String(report.snapshotReportStatus)}`);
  }

  if (report.status === "pass") {
    pushInvalidSnapshotSummary(failures, report.snapshotSummary);
  }

  for (const key of ["dryRunFailures", "snapshotVerificationFailures", "failures"] as const) {
    const length = arrayLength(report[key]);
    if (length === null) {
      failures.push(`invalid_array:${key}`);
    } else if (invalidStringArray(report[key])) {
      failures.push(`invalid_array_items:${key}`);
    } else if (length > 0) {
      failures.push(`${key}:${length}`);
    }
  }

  for (const key of ["splitSchemaIssues", "splitScopeGaps", "documentMoveCount", "documentIssueCount", "documentPlanIssueCount"] as const) {
    const value = nonNegativeNumberValue(report[key]);
    if (value === null) {
      failures.push(`invalid_number:${key}`);
    } else if (key !== "documentMoveCount" && value > 0) {
      failures.push(`${key}:${value}`);
    }
  }

  return failures;
}

export function assertPhase7ReadinessReport(report: unknown): asserts report is Phase7ReadinessPreflight {
  const failures = collectPhase7ReadinessReportFailures(report);
  if (failures.length > 0) {
    throw new Error(`Phase 7 readiness report is not passable:\n${failures.join("\n")}`);
  }
}
