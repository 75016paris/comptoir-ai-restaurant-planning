import { describe, expect, test } from "bun:test";
import {
  deferredPhaseAllowlistedFiles,
  deferredPhasePatterns,
  deferredPhaseScanFiles,
  deferredPhaseScanRoots,
  findDeferredPhaseViolations,
  isDeferredPhaseScanCandidate,
  sortDeferredPhaseViolations,
} from "./deferred-phase-boundary-rules.js";

describe("deferred Phase 7 boundary rules", () => {
  test("detects owner payroll and physical tenancy implementation markers", () => {
    const text = [
      "const ownerDbPath = '/tmp/example.sqlite';",
      "const tenantResolver = createResolver();",
      "const tenantMigrationRunner = buildRunner();",
      "const tenantBackup = await exportTenant();",
      "const ownerBackup = await archiveOwner();",
      "const ownerLevelPayroll = true;",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/example.ts", text)).toEqual([
      { file: "packages/api/src/example.ts", line: 1, match: "ownerDbPath" },
      { file: "packages/api/src/example.ts", line: 2, match: "tenantResolver" },
      { file: "packages/api/src/example.ts", line: 3, match: "tenantMigrationRunner" },
      { file: "packages/api/src/example.ts", line: 4, match: "tenantBackup" },
      { file: "packages/api/src/example.ts", line: 5, match: "ownerBackup" },
      { file: "packages/api/src/example.ts", line: 6, match: "ownerLevelPayroll" },
    ]);
  });

  test("detects snake_case implementation markers", () => {
    const text = [
      "owner_db",
      "owner_database",
      "tenant_database_path",
      "tenant_database",
      "master_database",
      "master_db",
      "tenant_connection",
      "tenant_export",
      "owner_restore",
      "owner_storage_namespace",
      "physical_tenant",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/drizzle/9999_future.sql", text).map((v) => v.match))
      .toEqual([
        "owner_db",
        "owner_database",
        "tenant_database_path",
        "tenant_database",
        "master_database",
        "master_db",
        "tenant_connection",
        "tenant_export",
        "owner_restore",
        "owner_storage_namespace",
        "physical_tenant",
      ]);
  });

  test("detects owner backup, restore, export, and delete variants", () => {
    const text = [
      "const restore = ownerRestore(ownerId);",
      "const exporter = owner_export(owner_id);",
      "const deletion = OWNER_DELETE;",
      "const backup = OWNER_BACKUP;",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/future-owner-maintenance.ts", text).map((v) => v.match))
      .toEqual(["ownerRestore", "owner_export", "OWNER_DELETE", "OWNER_BACKUP"]);
  });

  test("detects connection and object-storage namespace implementation markers", () => {
    const text = [
      "const ownerConnection = connectOwner();",
      "const tenantConnection = connectTenant();",
      "const masterConnection = connectMaster();",
      "const tenantDatabasePath = routeOwner();",
      "const objectStorageOwnerNamespace = owner.id;",
      "const objectStorageTenantNamespace = tenant.id;",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/future.ts", text).map((v) => v.match))
      .toEqual([
        "ownerConnection",
        "tenantConnection",
        "masterConnection",
        "tenantDatabasePath",
        "objectStorageOwnerNamespace",
        "objectStorageTenantNamespace",
      ]);
  });

  test("detects object-storage prefix implementation markers", () => {
    const text = [
      "const ownerPrefix = ownerStoragePrefix(ownerId);",
      "const tenantPrefix = tenant_storage_prefix(tenantId);",
      "const objectPrefix = OBJECT_STORAGE_OWNER_PREFIX;",
      "const objectKeyPrefix = tenantObjectKeyPrefix;",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/future-storage-prefix.ts", text).map((v) => v.match))
      .toEqual([
        "ownerStoragePrefix",
        "tenant_storage_prefix",
        "OBJECT_STORAGE_OWNER_PREFIX",
        "tenantObjectKeyPrefix",
      ]);
  });

  test("detects owner, tenant, and master DB path or factory variants", () => {
    const text = [
      "const ownerDatabasePath = '/tmp/owner.sqlite';",
      "const tenantDbPath = routeTenant();",
      "const masterDbPath = routeMaster();",
      "const masterDatabasePath = routeMasterDatabase();",
      "const ownerConnectionFactory = createOwnerConnection;",
      "const tenantDbFactory = createTenantDb;",
      "const masterDatabaseFactory = createMasterDatabase;",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/future-storage.ts", text).map((v) => v.match))
      .toEqual([
        "ownerDatabasePath",
        "tenantDbPath",
        "masterDbPath",
        "masterDatabasePath",
        "ownerConnectionFactory",
        "tenantDbFactory",
        "masterDatabaseFactory",
      ]);
  });

  test("allows logical owner-tenancy and current compatibility vocabulary", () => {
    const text = [
      "const ownerId = context.ownerId;",
      "const activeRestaurantId = session.activeRestaurantId;",
      "const restaurantMemberships = rows;",
      "const ownerMemberships = rows;",
      "const workerShareAuthorizations = rows;",
      "const dbPath = process.env.DATABASE_URL;",
      "const databasePath = process.env.DATABASE_URL;",
      "const connection = createSqliteConnection(databasePath);",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/current-logical-tenancy.ts", text)).toEqual([]);
  });

  test("detects Phase 7-style environment variable names but allows current DATABASE_URL", () => {
    const text = [
      "const current = process.env.DATABASE_URL;",
      "const owner = process.env.OWNER_DB_PATH;",
      "const tenant = process.env.TENANT_DATABASE_URL;",
      "const master = process.env.MASTER_DATABASE_URL;",
      "const namespace = process.env.OBJECT_STORAGE_OWNER_NAMESPACE;",
      "const resolver = process.env.TENANT_RESOLVER;",
      "const connection = process.env.TENANT_CONNECTION_FACTORY;",
      "const factory = process.env.OWNER_DATABASE_FACTORY;",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/src/env.ts", text).map((v) => v.match))
      .toEqual([
        "OWNER_DB_PATH",
        "TENANT_DATABASE_URL",
        "MASTER_DATABASE_URL",
        "OBJECT_STORAGE_OWNER_NAMESPACE",
        "TENANT_RESOLVER",
        "TENANT_CONNECTION_FACTORY",
        "OWNER_DATABASE_FACTORY",
      ]);
  });

  test("detects deferred markers in shell helper content", () => {
    const text = [
      "#!/usr/bin/env bash",
      "export TENANT_DB_PATH=/srv/comptoir/tenant.sqlite",
      "export OWNER_DATABASE_PATH=/srv/comptoir/owner.sqlite",
      "tenant_migration_runner \"$@\"",
    ].join("\n");

    expect(findDeferredPhaseViolations("scripts/future-tenant-migration.sh", text).map((v) => v.match))
      .toEqual([
        "TENANT_DB_PATH",
        "OWNER_DATABASE_PATH",
        "tenant_migration_runner",
      ]);
  });

  test("detects deferred markers in solver sidecar Python content", () => {
    const text = [
      "owner_db_path = '/srv/comptoir/owner.sqlite'",
      "tenant_resolver = build_resolver()",
    ].join("\n");

    expect(findDeferredPhaseViolations("packages/api/solver/future_sidecar.py", text).map((v) => v.match))
      .toEqual(["owner_db_path", "tenant_resolver"]);
  });

  test("keeps script and internal-tool scan roots inside the deferred boundary", () => {
    expect(deferredPhaseScanRoots).toEqual(expect.arrayContaining([
      "scripts",
      "packages/api/scripts",
      "packages/api/solver",
      "packages/api/tools",
      "packages/web/scripts",
      "packages/whatsapp/tools",
    ]));
    expect(deferredPhaseAllowlistedFiles.has("packages/api/scripts/deferred-phase-boundary-rules.ts")).toBe(true);
    expect(deferredPhaseAllowlistedFiles.has("packages/api/src/db/phase7-schema-boundaries.ts")).toBe(true);
    expect(deferredPhaseAllowlistedFiles.has("packages/api/src/db/phase7-core-snapshot.ts")).toBe(true);
  });

  test("keeps package manifests inside the deferred boundary", () => {
    expect(deferredPhaseScanFiles).toEqual(expect.arrayContaining([
      "package.json",
      "packages/api/package.json",
      "packages/shared/package.json",
      "packages/web/package.json",
      "packages/whatsapp/package.json",
    ]));

    const text = JSON.stringify({
      scripts: {
        "phase7:migrate": "TENANT_DB_PATH=/srv/tenant.sqlite bun run migrate",
      },
    }, null, 2);

    expect(findDeferredPhaseViolations("package.json", text).map((v) => v.match))
      .toEqual(["TENANT_DB_PATH"]);
  });

  test("keeps environment and deployment-adjacent config files inside the deferred boundary", () => {
    expect(deferredPhaseScanFiles).toEqual(expect.arrayContaining([
      ".env.example",
      "packages/whatsapp/.env.example",
      "packages/api/drizzle.config.ts",
      "packages/api/migrate.ts",
      "packages/api/solver/Dockerfile",
      "packages/api/solver/cpsat-solver.service",
      "packages/web/vite.config.ts",
    ]));

    const text = [
      "TENANT_DATABASE_URL=file:/srv/comptoir/tenant.sqlite",
      "OWNER_STORAGE_NAMESPACE=owner-123",
    ].join("\n");

    expect(findDeferredPhaseViolations(".env.example", text).map((v) => v.match))
      .toEqual(["TENANT_DATABASE_URL", "OWNER_STORAGE_NAMESPACE"]);
  });

  test("keeps explicit scan files unique, scannable, and out of documentation", () => {
    expect(new Set(deferredPhaseScanFiles).size).toBe(deferredPhaseScanFiles.length);
    expect(deferredPhaseScanFiles.every(isDeferredPhaseScanCandidate)).toBe(true);
    expect(deferredPhaseScanFiles.some((file) => file.startsWith("docs/") || file.endsWith(".md"))).toBe(false);
  });

  test("sorts violations deterministically across files and matches", () => {
    const input = [
      { file: "packages/web/src/future.ts", line: 4, match: "tenantDbPath" },
      { file: "packages/api/src/future.ts", line: 9, match: "tenantDbPath" },
      { file: "packages/api/src/future.ts", line: 2, match: "ownerDbPath" },
      { file: "packages/api/src/future.ts", line: 2, match: "masterDbPath" },
    ];

    expect(sortDeferredPhaseViolations(input)).toEqual([
      { file: "packages/api/src/future.ts", line: 2, match: "masterDbPath" },
      { file: "packages/api/src/future.ts", line: 2, match: "ownerDbPath" },
      { file: "packages/api/src/future.ts", line: 9, match: "tenantDbPath" },
      { file: "packages/web/src/future.ts", line: 4, match: "tenantDbPath" },
    ]);
    expect(sortDeferredPhaseViolations(input)).not.toBe(input);
  });

  test("scans production TypeScript, Python, config, SQL, shell, JSON, env examples, Dockerfiles, and services while ignoring tests", () => {
    expect(isDeferredPhaseScanCandidate("future.ts")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.tsx")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.js")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.cjs")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.mjs")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.py")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.sql")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.sh")).toBe(true);
    expect(isDeferredPhaseScanCandidate("package.json")).toBe(true);
    expect(isDeferredPhaseScanCandidate(".env.example")).toBe(true);
    expect(isDeferredPhaseScanCandidate("packages/whatsapp/.env.example")).toBe(true);
    expect(isDeferredPhaseScanCandidate("Dockerfile")).toBe(true);
    expect(isDeferredPhaseScanCandidate("packages/api/solver/Dockerfile")).toBe(true);
    expect(isDeferredPhaseScanCandidate("cpsat-solver.service")).toBe(true);
    expect(isDeferredPhaseScanCandidate("future.test.ts")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.test.tsx")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.test.js")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.test.cjs")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.test.mjs")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.spec.ts")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.spec.js")).toBe(false);
    expect(isDeferredPhaseScanCandidate("test_future.py")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future_test.py")).toBe(false);
    expect(isDeferredPhaseScanCandidate("future.md")).toBe(false);
  });

  test("keeps the deferred marker set broad enough for the Phase 7 start gate", () => {
    expect(deferredPhasePatterns.length).toBeGreaterThanOrEqual(99);
  });
});
