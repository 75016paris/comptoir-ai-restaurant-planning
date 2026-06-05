export type DeferredPhaseViolation = {
  file: string;
  line: number;
  match: string;
};

export const deferredPhaseScanRoots = [
  "scripts",
  "packages/api/scripts",
  "packages/api/solver",
  "packages/api/tools",
  "packages/api/src",
  "packages/api/drizzle",
  "packages/shared/src",
  "packages/web/scripts",
  "packages/web/src",
  "packages/whatsapp/src",
  "packages/whatsapp/tools",
];

export const deferredPhaseScanFiles = [
  ".env.example",
  "package.json",
  "packages/api/drizzle.config.ts",
  "packages/api/migrate.ts",
  "packages/api/package.json",
  "packages/api/solver/Dockerfile",
  "packages/api/solver/cpsat-solver.service",
  "packages/shared/package.json",
  "packages/web/.i18next-parser.config.cjs",
  "packages/web/eslint.config.js",
  "packages/web/package.json",
  "packages/web/vite.config.ts",
  "packages/whatsapp/.env.example",
  "packages/whatsapp/package.json",
];

export const deferredPhaseAllowlistedFiles = new Set([
  "packages/api/scripts/deferred-phase-boundary-rules.ts",
  "packages/api/src/db/phase7-schema-boundaries.ts",
  "packages/api/src/db/phase7-core-snapshot.ts",
]);

export function isDeferredPhaseScanCandidate(filePath: string) {
  return (
    /(^|\/)\.env\.example$/.test(filePath) ||
    /(^|\/)Dockerfile$/.test(filePath) ||
    /\.(ts|tsx|js|cjs|mjs|py|sql|sh|json|service)$/.test(filePath)
  ) &&
    !/\.(test|spec)\.(ts|tsx|js|cjs|mjs)$/.test(filePath) &&
    !/(^|\/)(test_.*|.*_test)\.py$/.test(filePath);
}

export const deferredPhasePatterns = [
  /\bownerPayroll\b/g,
  /\bowner_payroll\b/g,
  /\bOWNER_PAYROLL\b/g,
  /\bownerLevelPayroll\b/g,
  /\bowner_level_payroll\b/g,
  /\bOWNER_LEVEL_PAYROLL\b/g,
  /\bownerDatabase\b/g,
  /\bowner_database\b/g,
  /\bOWNER_DATABASE\b/g,
  /\bOWNER_DATABASE_URL\b/g,
  /\bownerDb\b/g,
  /\bowner_db\b/g,
  /\bOWNER_DB\b/g,
  /\bOWNER_DB_PATH\b/g,
  /\btenantDatabase\b/g,
  /\btenant_database\b/g,
  /\bTENANT_DATABASE\b/g,
  /\bTENANT_DATABASE_URL\b/g,
  /\btenantDatabasePath\b/g,
  /\btenant_database_path\b/g,
  /\bTENANT_DATABASE_PATH\b/g,
  /\bownerDatabasePath\b/g,
  /\bowner_database_path\b/g,
  /\bOWNER_DATABASE_PATH\b/g,
  /\bownerDbPath\b/g,
  /\bowner_db_path\b/g,
  /\btenantDbPath\b/g,
  /\btenant_db_path\b/g,
  /\bTENANT_DB\b/g,
  /\bTENANT_DB_PATH\b/g,
  /\bmasterDbPath\b/g,
  /\bmaster_db_path\b/g,
  /\bMASTER_DB\b/g,
  /\bMASTER_DB_PATH\b/g,
  /\bmasterDatabasePath\b/g,
  /\bmaster_database_path\b/g,
  /\bMASTER_DATABASE\b/g,
  /\bMASTER_DATABASE_URL\b/g,
  /\bMASTER_DATABASE_PATH\b/g,
  /\btenantDb\b/g,
  /\btenant_db\b/g,
  /\bmasterDb\b/g,
  /\bmaster_db\b/g,
  /\bmasterDatabase\b/g,
  /\bmaster_database\b/g,
  /\bownerConnection\b/g,
  /\bowner_connection\b/g,
  /\bOWNER_CONNECTION\b/g,
  /\btenantConnection\b/g,
  /\btenant_connection\b/g,
  /\bTENANT_CONNECTION\b/g,
  /\bmasterConnection\b/g,
  /\bmaster_connection\b/g,
  /\bMASTER_CONNECTION\b/g,
  /\bownerConnectionFactory\b/g,
  /\bowner_connection_factory\b/g,
  /\bOWNER_CONNECTION_FACTORY\b/g,
  /\btenantConnectionFactory\b/g,
  /\btenant_connection_factory\b/g,
  /\bTENANT_CONNECTION_FACTORY\b/g,
  /\bmasterConnectionFactory\b/g,
  /\bmaster_connection_factory\b/g,
  /\bMASTER_CONNECTION_FACTORY\b/g,
  /\bownerDbFactory\b/g,
  /\bowner_db_factory\b/g,
  /\bOWNER_DB_FACTORY\b/g,
  /\btenantDbFactory\b/g,
  /\btenant_db_factory\b/g,
  /\bTENANT_DB_FACTORY\b/g,
  /\bmasterDbFactory\b/g,
  /\bmaster_db_factory\b/g,
  /\bMASTER_DB_FACTORY\b/g,
  /\bownerDatabaseFactory\b/g,
  /\bowner_database_factory\b/g,
  /\bOWNER_DATABASE_FACTORY\b/g,
  /\btenantDatabaseFactory\b/g,
  /\btenant_database_factory\b/g,
  /\bTENANT_DATABASE_FACTORY\b/g,
  /\bmasterDatabaseFactory\b/g,
  /\bmaster_database_factory\b/g,
  /\bMASTER_DATABASE_FACTORY\b/g,
  /\btenantResolver\b/g,
  /\btenant_resolver\b/g,
  /\bTENANT_RESOLVER\b/g,
  /\btenantMigrationRunner\b/g,
  /\btenant_migration_runner\b/g,
  /\bTENANT_MIGRATION_RUNNER\b/g,
  /\btenantBackup\b/g,
  /\btenant_backup\b/g,
  /\bTENANT_BACKUP\b/g,
  /\bownerBackup\b/g,
  /\bowner_backup\b/g,
  /\bOWNER_BACKUP\b/g,
  /\btenantRestore\b/g,
  /\btenant_restore\b/g,
  /\bTENANT_RESTORE\b/g,
  /\bownerRestore\b/g,
  /\bowner_restore\b/g,
  /\bOWNER_RESTORE\b/g,
  /\btenantExport\b/g,
  /\btenant_export\b/g,
  /\bTENANT_EXPORT\b/g,
  /\bownerExport\b/g,
  /\bowner_export\b/g,
  /\bOWNER_EXPORT\b/g,
  /\btenantDelete\b/g,
  /\btenant_delete\b/g,
  /\bTENANT_DELETE\b/g,
  /\bownerDelete\b/g,
  /\bowner_delete\b/g,
  /\bOWNER_DELETE\b/g,
  /\bownerStorageNamespace\b/g,
  /\bowner_storage_namespace\b/g,
  /\bOWNER_STORAGE_NAMESPACE\b/g,
  /\btenantStorageNamespace\b/g,
  /\btenant_storage_namespace\b/g,
  /\bTENANT_STORAGE_NAMESPACE\b/g,
  /\bobjectStorageOwnerNamespace\b/g,
  /\bobject_storage_owner_namespace\b/g,
  /\bOBJECT_STORAGE_OWNER_NAMESPACE\b/g,
  /\bobjectStorageTenantNamespace\b/g,
  /\bobject_storage_tenant_namespace\b/g,
  /\bOBJECT_STORAGE_TENANT_NAMESPACE\b/g,
  /\bownerStoragePrefix\b/g,
  /\bowner_storage_prefix\b/g,
  /\bOWNER_STORAGE_PREFIX\b/g,
  /\btenantStoragePrefix\b/g,
  /\btenant_storage_prefix\b/g,
  /\bTENANT_STORAGE_PREFIX\b/g,
  /\bobjectStorageOwnerPrefix\b/g,
  /\bobject_storage_owner_prefix\b/g,
  /\bOBJECT_STORAGE_OWNER_PREFIX\b/g,
  /\bobjectStorageTenantPrefix\b/g,
  /\bobject_storage_tenant_prefix\b/g,
  /\bOBJECT_STORAGE_TENANT_PREFIX\b/g,
  /\bownerObjectKeyPrefix\b/g,
  /\bowner_object_key_prefix\b/g,
  /\bOWNER_OBJECT_KEY_PREFIX\b/g,
  /\btenantObjectKeyPrefix\b/g,
  /\btenant_object_key_prefix\b/g,
  /\bTENANT_OBJECT_KEY_PREFIX\b/g,
  /\bphysicalTenant\b/g,
  /\bphysical_tenant\b/g,
  /\bPHYSICAL_TENANT\b/g,
];

function lineNumberForIndex(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

export function sortDeferredPhaseViolations(violations: DeferredPhaseViolation[]) {
  return [...violations].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.match.localeCompare(b.match)
  );
}

export function findDeferredPhaseViolations(file: string, text: string): DeferredPhaseViolation[] {
  const violations: DeferredPhaseViolation[] = [];

  for (const pattern of deferredPhasePatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      violations.push({
        file,
        line: lineNumberForIndex(text, match.index ?? 0),
        match: match[0],
      });
    }
  }

  return sortDeferredPhaseViolations(violations);
}
