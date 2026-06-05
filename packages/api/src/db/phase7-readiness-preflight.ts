import type { Database } from "bun:sqlite";
import { createPhase7CoreSnapshot, verifyPhase7CoreSnapshot } from "./phase7-core-snapshot";
import { collectPhase7DryRunSummary } from "./phase7-export-dry-run";
import { buildPhase7SnapshotReport } from "./phase7-snapshot-report";
import { buildPhase7DocumentStoragePlan, verifyPhase7DocumentStoragePlan } from "./phase7-document-storage-audit";

export const PHASE7_READINESS_PREFLIGHT_VERSION = 2;

export type Phase7ReadinessSnapshotSummary = {
  ownerDatabases: number;
  restaurants: number;
  users: number;
  services: number;
  documents: number;
  notifications: number;
  chatMessages: number;
  cronRuns: number;
  totalDatabaseBytes: number;
};

export type Phase7ReadinessPreflight = {
  reportVersion: typeof PHASE7_READINESS_PREFLIGHT_VERSION;
  generatedAt: string;
  status: "pass" | "fail";
  directory: string;
  dryRunFailures: string[];
  splitSchemaIssues: number;
  splitScopeGaps: number;
  snapshotVerificationFailures: string[];
  snapshotReportStatus: "pass" | "fail";
  documentMoveCount: number;
  documentIssueCount: number;
  documentPlanIssueCount: number;
  snapshotSummary: Phase7ReadinessSnapshotSummary | null;
  failures: string[];
};

function baseFailures(input: {
  dryRun: ReturnType<typeof collectPhase7DryRunSummary>;
  documentPlan: ReturnType<typeof buildPhase7DocumentStoragePlan>;
  documentPlanVerification: ReturnType<typeof verifyPhase7DocumentStoragePlan>;
}) {
  return [
    ...input.dryRun.failures.map((failure) => `dry_run:${failure}`),
    ...input.dryRun.splitSchemaIssues.map((issue) => `split_schema:${issue.table}:${issue.missingColumns.join(",")}`),
    ...input.dryRun.splitScopeGaps.map((gap) => `split_scope:${gap.table}:${gap.issue}:${gap.count}`),
    ...input.documentPlan.issues.map((issue) => `document:${issue.code}:${issue.documentId}`),
    ...input.documentPlanVerification.issues.map((issue) => `document_plan:${issue.code}:${issue.detail}`),
  ];
}

export function runPhase7ReadinessPreflight(input: {
  source: Database;
  directory: string;
  generatedAt?: string;
}): Phase7ReadinessPreflight {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const dryRun = collectPhase7DryRunSummary(input.source);
  const documentPlan = buildPhase7DocumentStoragePlan(input.source);
  const documentPlanVerification = verifyPhase7DocumentStoragePlan(input.source, documentPlan);
  const failuresBeforeSnapshot = baseFailures({ dryRun, documentPlan, documentPlanVerification });

  if (dryRun.failures.length > 0 || dryRun.splitSchemaIssues.length > 0 || dryRun.splitScopeGaps.length > 0) {
    return {
      reportVersion: PHASE7_READINESS_PREFLIGHT_VERSION,
      generatedAt,
      status: "fail",
      directory: input.directory,
      dryRunFailures: dryRun.failures,
      splitSchemaIssues: dryRun.splitSchemaIssues.length,
      splitScopeGaps: dryRun.splitScopeGaps.length,
      snapshotVerificationFailures: [],
      snapshotReportStatus: "fail",
      documentMoveCount: documentPlan.moveCount,
      documentIssueCount: documentPlan.issues.length,
      documentPlanIssueCount: documentPlanVerification.issues.length,
      snapshotSummary: null,
      failures: failuresBeforeSnapshot,
    };
  }

  let snapshotVerificationFailures: string[];
  let snapshotReportStatus: "pass" | "fail";
  let snapshotSummary: Phase7ReadinessSnapshotSummary | null = null;
  let snapshotFailure: string | null = null;

  try {
    const snapshot = createPhase7CoreSnapshot({
      source: input.source,
      directory: input.directory,
    });
    snapshotVerificationFailures = verifyPhase7CoreSnapshot(snapshot);
    const snapshotReport = buildPhase7SnapshotReport(input.directory);
    snapshotReportStatus = snapshotReport.status;
    snapshotSummary = {
      ownerDatabases: snapshotReport.totals.ownerDatabases,
      restaurants: snapshotReport.totals.restaurants,
      users: snapshotReport.totals.users,
      services: snapshotReport.totals.services,
      documents: snapshotReport.totals.documents,
      notifications: snapshotReport.totals.notifications,
      chatMessages: snapshotReport.totals.chatMessages,
      cronRuns: snapshotReport.totals.cronRuns,
      totalDatabaseBytes: snapshotReport.totals.totalDatabaseBytes,
    };
  } catch (error) {
    snapshotVerificationFailures = [];
    snapshotReportStatus = "fail";
    snapshotFailure = error instanceof Error ? error.message : String(error);
  }

  const failures = [
    ...failuresBeforeSnapshot,
    ...snapshotVerificationFailures.map((failure) => `snapshot:${failure}`),
    ...(snapshotReportStatus === "pass" ? [] : ["snapshot_report:status_fail"]),
    ...(snapshotFailure ? [`snapshot_create:${snapshotFailure}`] : []),
  ];

  return {
    reportVersion: PHASE7_READINESS_PREFLIGHT_VERSION,
    generatedAt,
    status: failures.length === 0 ? "pass" : "fail",
    directory: input.directory,
    dryRunFailures: dryRun.failures,
    splitSchemaIssues: dryRun.splitSchemaIssues.length,
    splitScopeGaps: dryRun.splitScopeGaps.length,
    snapshotVerificationFailures,
    snapshotReportStatus,
    documentMoveCount: documentPlan.moveCount,
    documentIssueCount: documentPlan.issues.length,
    documentPlanIssueCount: documentPlanVerification.issues.length,
    snapshotSummary,
    failures,
  };
}
