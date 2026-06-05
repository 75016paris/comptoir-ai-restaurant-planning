import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PHASE7_CORE_SNAPSHOT_COPIED_SPLIT_TABLES,
  PHASE7_CORE_SNAPSHOT_COPIED_OWNER_TABLES,
  PHASE7_CORE_SNAPSHOT_MANIFEST,
  type Phase7CoreSnapshotManifest,
} from "./phase7-core-snapshot";
import { phase7SplitTableExportBlockers, phase7SplitTablePlan } from "./phase7-owner-schema";
import { verifyPhase7CoreSnapshotDirectory } from "./phase7-core-snapshot-verifier";
import { phase7OwnerTables, phase7SplitTables } from "./phase7-schema-boundaries";

export type Phase7SnapshotReport = {
  status: "pass" | "fail";
  directory: string;
  manifestPath: string;
  snapshotVersion: number | null;
  master: {
    filePath: string;
    sha256: string | null;
    sizeBytes: number | null;
    copied: Phase7CoreSnapshotManifest["copied"]["master"] | null;
    dryRun: Phase7CoreSnapshotManifest["dryRun"]["master"] | null;
  };
  owners: Array<{
    ownerId: string;
    filePath: string;
    sha256: string | null;
    sizeBytes: number | null;
    copied: Phase7CoreSnapshotManifest["copied"]["owners"][number] | null;
    verified: {
      restaurants: number;
      users: number;
      restaurantMemberships: number;
      workerProfiles: number;
      workerShareAuthorizations: number;
      staffingProfiles: number;
      serviceTemplates: number;
      serviceTemplateOverrides: number;
      staffingSchedule: number;
      staffingTargets: number;
      staffingAnalysisCache: number;
      subRoleTrainingCosts: number;
      subRoleTrainingMoves: number;
      onboardingTokens: number;
      workerWeeklyHours: number;
      services: number;
      timeClocks: number;
      dailyRevenue: number;
      restaurantClosures: number;
      publishedWeeks: number;
      calendarEvents: number;
      workerAvailability: number;
      workerPreferredSchedule: number;
      workerRestrictions: number;
      emailRecipients: number;
      contractTemplates: number;
      weatherData: number;
      adminAlerts: number;
      holidayRequests: number;
      replacementRequests: number;
      openShifts: number;
      restrictionRequests: number;
      documents: number;
      auditLogs: number;
      notifications: number;
      chatMessages: number;
      cronRuns: number;
    } | null;
  }>;
  totals: {
    ownerDatabases: number;
    restaurants: number;
    users: number;
    restaurantMemberships: number;
    workerProfiles: number;
    workerShareAuthorizations: number;
    staffingProfiles: number;
    serviceTemplates: number;
    serviceTemplateOverrides: number;
    staffingSchedule: number;
    staffingTargets: number;
    staffingAnalysisCache: number;
    subRoleTrainingCosts: number;
    subRoleTrainingMoves: number;
    onboardingTokens: number;
    workerWeeklyHours: number;
    services: number;
    timeClocks: number;
    dailyRevenue: number;
    restaurantClosures: number;
    publishedWeeks: number;
    calendarEvents: number;
    workerAvailability: number;
    workerPreferredSchedule: number;
    workerRestrictions: number;
    emailRecipients: number;
    contractTemplates: number;
    weatherData: number;
    adminAlerts: number;
    holidayRequests: number;
    replacementRequests: number;
    openShifts: number;
    restrictionRequests: number;
    documents: number;
    auditLogs: number;
    notifications: number;
    chatMessages: number;
    cronRuns: number;
    totalDatabaseBytes: number;
  };
  inventory: {
    expectedFiles: string[];
    presentExpectedFiles: string[];
    missingExpectedFiles: string[];
    unexpectedSqliteFiles: string[];
  };
  tableCoverage: {
    ownerTablesTotal: number;
    ownerTablesCopied: string[];
    ownerTablesRemaining: string[];
    splitTablesRemaining: string[];
  };
  splitTables: Phase7CoreSnapshotManifest["dryRun"]["splitTables"] | null;
  splitSchemaIssues: Phase7CoreSnapshotManifest["dryRun"]["splitSchemaIssues"] | null;
  splitScopeGaps: Phase7CoreSnapshotManifest["dryRun"]["splitScopeGaps"] | null;
  remainingSplitRows: Record<string, number | null>;
  remainingSplitPlans: Record<string, {
    master: string;
    owner: string;
    blocker: string;
  }>;
  verificationFailures: string[];
};

function readManifest(manifestPath: string) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Phase7CoreSnapshotManifest;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function fingerprint(manifest: Phase7CoreSnapshotManifest | null, filePath: string) {
  const entry = manifest?.fileFingerprints[filePath];
  return {
    sha256: entry?.sha256 ?? null,
    sizeBytes: entry?.sizeBytes ?? null,
  };
}

function listSqliteFiles(directory: string) {
  if (!existsSync(directory)) return [];

  const found: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    for (const entry of readdirSync(current)) {
      const filePath = join(current, entry);
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        pending.push(filePath);
      } else if (entry.endsWith(".sqlite") || entry.endsWith(".db")) {
        found.push(filePath);
      }
    }
  }

  return found.sort();
}

export function buildPhase7SnapshotReport(directory: string): Phase7SnapshotReport {
  const manifestPath = join(directory, PHASE7_CORE_SNAPSHOT_MANIFEST);
  const verification = verifyPhase7CoreSnapshotDirectory(directory);
  const rawManifest = existsSync(manifestPath) ? readManifest(manifestPath) : null;
  const manifest = rawManifest instanceof Error ? null : rawManifest;
  const verificationFailures = [
    ...(rawManifest instanceof Error ? [rawManifest.message] : []),
    ...verification.failures,
  ];

  const ownerIds = new Set<string>([
    ...Object.keys(manifest?.ownerPaths ?? {}),
    ...verification.checkedOwners.map((owner) => owner.ownerId),
    ...(manifest?.copied.owners.map((owner) => owner.ownerId) ?? []),
  ]);

  const owners = [...ownerIds].sort().map((ownerId) => {
    const filePath = manifest?.ownerPaths[ownerId] ?? verification.checkedOwners.find((owner) => owner.ownerId === ownerId)?.filePath ?? "";
    const copied = manifest?.copied.owners.find((owner) => owner.ownerId === ownerId) ?? null;
    const verifiedOwner = verification.checkedOwners.find((owner) => owner.ownerId === ownerId) ?? null;
    const file = fingerprint(manifest, filePath);
    return {
      ownerId,
      filePath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      copied,
      verified: verifiedOwner
        ? {
            restaurants: verifiedOwner.restaurants,
            users: verifiedOwner.users,
            restaurantMemberships: verifiedOwner.restaurantMemberships,
            workerProfiles: verifiedOwner.workerProfiles,
            workerShareAuthorizations: verifiedOwner.workerShareAuthorizations,
            staffingProfiles: verifiedOwner.staffingProfiles,
            serviceTemplates: verifiedOwner.serviceTemplates,
            serviceTemplateOverrides: verifiedOwner.serviceTemplateOverrides,
            staffingSchedule: verifiedOwner.staffingSchedule,
            staffingTargets: verifiedOwner.staffingTargets,
            staffingAnalysisCache: verifiedOwner.staffingAnalysisCache,
            subRoleTrainingCosts: verifiedOwner.subRoleTrainingCosts,
            subRoleTrainingMoves: verifiedOwner.subRoleTrainingMoves,
            onboardingTokens: verifiedOwner.onboardingTokens,
            workerWeeklyHours: verifiedOwner.workerWeeklyHours,
            services: verifiedOwner.services,
            timeClocks: verifiedOwner.timeClocks,
            dailyRevenue: verifiedOwner.dailyRevenue,
            restaurantClosures: verifiedOwner.restaurantClosures,
            publishedWeeks: verifiedOwner.publishedWeeks,
            calendarEvents: verifiedOwner.calendarEvents,
            workerAvailability: verifiedOwner.workerAvailability,
            workerPreferredSchedule: verifiedOwner.workerPreferredSchedule,
            workerRestrictions: verifiedOwner.workerRestrictions,
            emailRecipients: verifiedOwner.emailRecipients,
            contractTemplates: verifiedOwner.contractTemplates,
            weatherData: verifiedOwner.weatherData,
            adminAlerts: verifiedOwner.adminAlerts,
            holidayRequests: verifiedOwner.holidayRequests,
            replacementRequests: verifiedOwner.replacementRequests,
            openShifts: verifiedOwner.openShifts,
            restrictionRequests: verifiedOwner.restrictionRequests,
            documents: verifiedOwner.documents,
            auditLogs: verifiedOwner.auditLogs,
            notifications: verifiedOwner.notifications,
            chatMessages: verifiedOwner.chatMessages,
            cronRuns: verifiedOwner.cronRuns,
          }
        : null,
    };
  });

  const totals = owners.reduce<Phase7SnapshotReport["totals"]>((acc, owner) => ({
    ownerDatabases: acc.ownerDatabases + 1,
    restaurants: acc.restaurants + (owner.copied?.restaurants ?? owner.verified?.restaurants ?? 0),
    users: acc.users + (owner.copied?.users ?? owner.verified?.users ?? 0),
    restaurantMemberships: acc.restaurantMemberships + (owner.copied?.restaurantMemberships ?? owner.verified?.restaurantMemberships ?? 0),
    workerProfiles: acc.workerProfiles + (owner.copied?.workerProfiles ?? owner.verified?.workerProfiles ?? 0),
    workerShareAuthorizations: acc.workerShareAuthorizations + (owner.copied?.workerShareAuthorizations ?? owner.verified?.workerShareAuthorizations ?? 0),
    staffingProfiles: acc.staffingProfiles + (owner.copied?.staffingProfiles ?? owner.verified?.staffingProfiles ?? 0),
    serviceTemplates: acc.serviceTemplates + (owner.copied?.serviceTemplates ?? owner.verified?.serviceTemplates ?? 0),
    serviceTemplateOverrides: acc.serviceTemplateOverrides + (owner.copied?.serviceTemplateOverrides ?? owner.verified?.serviceTemplateOverrides ?? 0),
    staffingSchedule: acc.staffingSchedule + (owner.copied?.staffingSchedule ?? owner.verified?.staffingSchedule ?? 0),
    staffingTargets: acc.staffingTargets + (owner.copied?.staffingTargets ?? owner.verified?.staffingTargets ?? 0),
    staffingAnalysisCache: acc.staffingAnalysisCache + (owner.copied?.staffingAnalysisCache ?? owner.verified?.staffingAnalysisCache ?? 0),
    subRoleTrainingCosts: acc.subRoleTrainingCosts + (owner.copied?.subRoleTrainingCosts ?? owner.verified?.subRoleTrainingCosts ?? 0),
    subRoleTrainingMoves: acc.subRoleTrainingMoves + (owner.copied?.subRoleTrainingMoves ?? owner.verified?.subRoleTrainingMoves ?? 0),
    onboardingTokens: acc.onboardingTokens + (owner.copied?.onboardingTokens ?? owner.verified?.onboardingTokens ?? 0),
    workerWeeklyHours: acc.workerWeeklyHours + (owner.copied?.workerWeeklyHours ?? owner.verified?.workerWeeklyHours ?? 0),
    services: acc.services + (owner.copied?.services ?? owner.verified?.services ?? 0),
    timeClocks: acc.timeClocks + (owner.copied?.timeClocks ?? owner.verified?.timeClocks ?? 0),
    dailyRevenue: acc.dailyRevenue + (owner.copied?.dailyRevenue ?? owner.verified?.dailyRevenue ?? 0),
    restaurantClosures: acc.restaurantClosures + (owner.copied?.restaurantClosures ?? owner.verified?.restaurantClosures ?? 0),
    publishedWeeks: acc.publishedWeeks + (owner.copied?.publishedWeeks ?? owner.verified?.publishedWeeks ?? 0),
    calendarEvents: acc.calendarEvents + (owner.copied?.calendarEvents ?? owner.verified?.calendarEvents ?? 0),
    workerAvailability: acc.workerAvailability + (owner.copied?.workerAvailability ?? owner.verified?.workerAvailability ?? 0),
    workerPreferredSchedule: acc.workerPreferredSchedule + (owner.copied?.workerPreferredSchedule ?? owner.verified?.workerPreferredSchedule ?? 0),
    workerRestrictions: acc.workerRestrictions + (owner.copied?.workerRestrictions ?? owner.verified?.workerRestrictions ?? 0),
    emailRecipients: acc.emailRecipients + (owner.copied?.emailRecipients ?? owner.verified?.emailRecipients ?? 0),
    contractTemplates: acc.contractTemplates + (owner.copied?.contractTemplates ?? owner.verified?.contractTemplates ?? 0),
    weatherData: acc.weatherData + (owner.copied?.weatherData ?? owner.verified?.weatherData ?? 0),
    adminAlerts: acc.adminAlerts + (owner.copied?.adminAlerts ?? owner.verified?.adminAlerts ?? 0),
    holidayRequests: acc.holidayRequests + (owner.copied?.holidayRequests ?? owner.verified?.holidayRequests ?? 0),
    replacementRequests: acc.replacementRequests + (owner.copied?.replacementRequests ?? owner.verified?.replacementRequests ?? 0),
    openShifts: acc.openShifts + (owner.copied?.openShifts ?? owner.verified?.openShifts ?? 0),
    restrictionRequests: acc.restrictionRequests + (owner.copied?.restrictionRequests ?? owner.verified?.restrictionRequests ?? 0),
    documents: acc.documents + (owner.copied?.documents ?? owner.verified?.documents ?? 0),
    auditLogs: acc.auditLogs + (owner.copied?.auditLogs ?? owner.verified?.auditLogs ?? 0),
    notifications: acc.notifications + (owner.copied?.notifications ?? owner.verified?.notifications ?? 0),
    chatMessages: acc.chatMessages + (owner.copied?.chatMessages ?? owner.verified?.chatMessages ?? 0),
    cronRuns: acc.cronRuns + (owner.copied?.cronRuns ?? owner.verified?.cronRuns ?? 0),
    totalDatabaseBytes: acc.totalDatabaseBytes + (owner.sizeBytes ?? 0),
  }), {
    ownerDatabases: 0,
    restaurants: 0,
    users: 0,
    restaurantMemberships: 0,
    workerProfiles: 0,
    workerShareAuthorizations: 0,
    staffingProfiles: 0,
    serviceTemplates: 0,
    serviceTemplateOverrides: 0,
    staffingSchedule: 0,
    staffingTargets: 0,
    staffingAnalysisCache: 0,
    subRoleTrainingCosts: 0,
    subRoleTrainingMoves: 0,
    onboardingTokens: 0,
    workerWeeklyHours: 0,
    services: 0,
    timeClocks: 0,
    dailyRevenue: 0,
    restaurantClosures: 0,
    publishedWeeks: 0,
    calendarEvents: 0,
    workerAvailability: 0,
    workerPreferredSchedule: 0,
    workerRestrictions: 0,
    emailRecipients: 0,
    contractTemplates: 0,
    weatherData: 0,
    adminAlerts: 0,
    holidayRequests: 0,
    replacementRequests: 0,
    openShifts: 0,
    restrictionRequests: 0,
    documents: 0,
    auditLogs: 0,
    notifications: 0,
    chatMessages: 0,
    cronRuns: 0,
    totalDatabaseBytes: fingerprint(manifest, manifest?.masterPath ?? verification.masterPath).sizeBytes ?? 0,
  });

  const masterFingerprint = fingerprint(manifest, manifest?.masterPath ?? verification.masterPath);
  const expectedFiles = [
    manifest?.masterPath ?? verification.masterPath,
    ...Object.values(manifest?.ownerPaths ?? {}),
  ].sort();
  const expectedFileSet = new Set(expectedFiles);
  const sqliteFiles = listSqliteFiles(directory);
  const inventory = {
    expectedFiles,
    presentExpectedFiles: expectedFiles.filter((filePath) => existsSync(filePath)),
    missingExpectedFiles: expectedFiles.filter((filePath) => !existsSync(filePath)),
    unexpectedSqliteFiles: sqliteFiles.filter((filePath) => !expectedFileSet.has(filePath)),
  };
  const copiedOwnerTableSet = new Set<string>(manifest?.scope?.copiedOwnerTables ?? PHASE7_CORE_SNAPSHOT_COPIED_OWNER_TABLES);
  const copiedSplitTableSet = new Set<string>(PHASE7_CORE_SNAPSHOT_COPIED_SPLIT_TABLES);
  const ownerTables = phase7OwnerTables.map((entry) => entry.table).sort();
  const tableCoverage = {
    ownerTablesTotal: ownerTables.length,
    ownerTablesCopied: [...copiedOwnerTableSet].sort(),
    ownerTablesRemaining: manifest?.scope?.remainingOwnerTables ?? ownerTables.filter((table) => !copiedOwnerTableSet.has(table)),
    splitTablesRemaining: manifest?.scope?.remainingSplitTables ?? phase7SplitTables.map((entry) => entry.table).filter((table) => !copiedSplitTableSet.has(table)).sort(),
  };
  const remainingSplitRows = Object.fromEntries(
    phase7SplitTables
      .filter((entry) => tableCoverage.splitTablesRemaining.includes(entry.table))
      .map((entry) => [entry.table, manifest?.dryRun.splitTables[entry.exportName] ?? null]),
  );
  const remainingSplitPlans = Object.fromEntries(
    phase7SplitTables
      .filter((entry) => tableCoverage.splitTablesRemaining.includes(entry.table))
      .map((entry) => [entry.table, {
        ...phase7SplitTablePlan[entry.table],
        blocker: phase7SplitTableExportBlockers[entry.table],
      }]),
  );

  return {
    status: verificationFailures.length === 0 && inventory.missingExpectedFiles.length === 0 && inventory.unexpectedSqliteFiles.length === 0 ? "pass" : "fail",
    directory,
    manifestPath,
    snapshotVersion: manifest?.snapshotVersion ?? null,
    master: {
      filePath: manifest?.masterPath ?? verification.masterPath,
      sha256: masterFingerprint.sha256,
      sizeBytes: masterFingerprint.sizeBytes,
      copied: manifest?.copied.master ?? null,
      dryRun: manifest?.dryRun.master ?? null,
    },
    owners,
    totals,
    inventory,
    tableCoverage,
    splitTables: manifest?.dryRun.splitTables ?? null,
    splitSchemaIssues: manifest?.dryRun.splitSchemaIssues ?? null,
    splitScopeGaps: manifest?.dryRun.splitScopeGaps ?? null,
    remainingSplitRows,
    remainingSplitPlans,
    verificationFailures: [
      ...verificationFailures,
      ...inventory.missingExpectedFiles.map((filePath) => `inventory: missing expected SQLite file ${filePath}`),
      ...inventory.unexpectedSqliteFiles.map((filePath) => `inventory: unexpected SQLite file ${filePath}`),
    ],
  };
}
