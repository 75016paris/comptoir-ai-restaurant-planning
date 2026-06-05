import type { Database } from "bun:sqlite";

export type Phase7DocumentStorageIssue = {
  documentId: string;
  code:
    | "ownerless_restaurant"
    | "missing_storage_key"
    | "pending_storage_key"
    | "restaurant_key_mismatch"
    | "user_key_mismatch"
    | "unmoved_storage_key";
  detail: string;
};

export type Phase7DocumentStorageAudit = {
  totalDocuments: number;
  objectDocuments: number;
  sqliteDocuments: number;
  readyObjectDocuments: number;
  relocationMoves: Array<{
    documentId: string;
    sourceKey: string;
    targetKey: string;
  }>;
  issues: Phase7DocumentStorageIssue[];
};

export type Phase7DocumentStoragePlan = {
  manifestVersion: 1;
  generatedAt: string;
  totalDocuments: number;
  objectDocuments: number;
  readyObjectDocuments: number;
  sqliteDocuments: number;
  moveCount: number;
  moves: Phase7DocumentStorageAudit["relocationMoves"];
  issues: Phase7DocumentStorageIssue[];
};

export type Phase7DocumentStoragePostMoveVerification = {
  manifestVersion: 1;
  generatedAt: string;
  totalDocuments: number;
  objectDocuments: number;
  readyObjectDocuments: number;
  sqliteDocuments: number;
  issues: Phase7DocumentStorageIssue[];
};

export type Phase7DocumentStoragePlanVerification = {
  manifestVersion: 1;
  generatedAt: string;
  expectedMoveCount: number;
  currentMoveCount: number;
  issues: Array<{
    code:
      | "invalid_manifest_version"
      | "duplicate_target_key"
      | "self_move"
      | "move_plan_mismatch"
      | "unsafe_current_rows";
    detail: string;
  }>;
};

type DocumentStorageRow = {
  id: string;
  restaurant_id: string;
  user_id: string;
  owner_id: string | null;
  storage_provider: string | null;
  storage_key: string | null;
};

function documentStorageRows(db: Database): DocumentStorageRow[] {
  return db.query(`
    SELECT
      d.id,
      d.restaurant_id,
      d.user_id,
      r.owner_id,
      d.storage_provider,
      d.storage_key
    FROM documents d
    LEFT JOIN restaurants r ON r.id = d.restaurant_id
  `).all() as DocumentStorageRow[];
}

function safeSegment(value: string) {
  return encodeURIComponent(value);
}

function restaurantKeyPrefix(restaurantId: string) {
  return `restaurants/${safeSegment(restaurantId)}/`;
}

function scopedKeyPrefix(ownerId: string, restaurantId: string) {
  return `owners/${safeSegment(ownerId)}/${restaurantKeyPrefix(restaurantId)}`;
}

export function collectPhase7DocumentStorageAudit(db: Database): Phase7DocumentStorageAudit {
  const rows = documentStorageRows(db);

  const issues: Phase7DocumentStorageIssue[] = [];
  let objectDocuments = 0;
  let sqliteDocuments = 0;
  let readyObjectDocuments = 0;
  const relocationMoves: Phase7DocumentStorageAudit["relocationMoves"] = [];

  for (const row of rows) {
    if (!row.owner_id) {
      issues.push({
        documentId: row.id,
        code: "ownerless_restaurant",
        detail: `Document ${row.id} belongs to restaurant ${row.restaurant_id} without owner_id`,
      });
    }

    if (row.storage_provider !== "ovh") {
      sqliteDocuments += 1;
      continue;
    }

    objectDocuments += 1;
    const storageKey = row.storage_key ?? "";

    if (!storageKey) {
      issues.push({
        documentId: row.id,
        code: "missing_storage_key",
        detail: `Document ${row.id} uses object storage without storage_key`,
      });
      continue;
    }

    if (storageKey.startsWith("pending/")) {
      issues.push({
        documentId: row.id,
        code: "pending_storage_key",
        detail: `Document ${row.id} still points to pending upload key ${storageKey}`,
      });
      continue;
    }

    const restaurantPrefix = restaurantKeyPrefix(row.restaurant_id);
    const targetPrefix = row.owner_id ? scopedKeyPrefix(row.owner_id, row.restaurant_id) : null;
    const hasCurrentPrefix = storageKey.startsWith(restaurantPrefix);
    const hasTargetPrefix = !!targetPrefix && storageKey.startsWith(targetPrefix);
    if (!hasCurrentPrefix && !hasTargetPrefix) {
      issues.push({
        documentId: row.id,
        code: "restaurant_key_mismatch",
        detail: `Document ${row.id} key ${storageKey} does not start with ${targetPrefix ? `${restaurantPrefix} or ${targetPrefix}` : restaurantPrefix}`,
      });
      continue;
    }

    const userSegment = `/users/${safeSegment(row.user_id)}/`;
    if (!storageKey.includes(userSegment)) {
      issues.push({
        documentId: row.id,
        code: "user_key_mismatch",
        detail: `Document ${row.id} key ${storageKey} does not include ${userSegment}`,
      });
      continue;
    }

    readyObjectDocuments += 1;
    if (row.owner_id && hasCurrentPrefix && !hasTargetPrefix) {
      relocationMoves.push({
        documentId: row.id,
        sourceKey: storageKey,
        targetKey: `${targetPrefix}${storageKey.slice(restaurantPrefix.length)}`,
      });
    }
  }

  return {
    totalDocuments: rows.length,
    objectDocuments,
    sqliteDocuments,
    readyObjectDocuments,
    relocationMoves,
    issues,
  };
}

export function buildPhase7DocumentStoragePlan(db: Database, generatedAt = new Date().toISOString()): Phase7DocumentStoragePlan {
  const audit = collectPhase7DocumentStorageAudit(db);
  return {
    manifestVersion: 1,
    generatedAt,
    totalDocuments: audit.totalDocuments,
    objectDocuments: audit.objectDocuments,
    readyObjectDocuments: audit.readyObjectDocuments,
    sqliteDocuments: audit.sqliteDocuments,
    moveCount: audit.relocationMoves.length,
    moves: audit.relocationMoves,
    issues: audit.issues,
  };
}

export function verifyPhase7DocumentStoragePostMove(db: Database, generatedAt = new Date().toISOString()): Phase7DocumentStoragePostMoveVerification {
  const baseAudit = collectPhase7DocumentStorageAudit(db);
  const issues = [...baseAudit.issues];

  for (const row of documentStorageRows(db)) {
    if (row.storage_provider !== "ovh" || !row.storage_key || !row.owner_id) continue;
    const targetPrefix = scopedKeyPrefix(row.owner_id, row.restaurant_id);
    if (!row.storage_key.startsWith(targetPrefix)) {
      issues.push({
        documentId: row.id,
        code: "unmoved_storage_key",
        detail: `Document ${row.id} key ${row.storage_key} has not moved to ${targetPrefix}`,
      });
    }
  }

  return {
    manifestVersion: 1,
    generatedAt,
    totalDocuments: baseAudit.totalDocuments,
    objectDocuments: baseAudit.objectDocuments,
    readyObjectDocuments: baseAudit.readyObjectDocuments,
    sqliteDocuments: baseAudit.sqliteDocuments,
    issues,
  };
}

function moveSignature(move: Phase7DocumentStorageAudit["relocationMoves"][number]) {
  return `${move.documentId}\u0000${move.sourceKey}\u0000${move.targetKey}`;
}

export function verifyPhase7DocumentStoragePlan(
  db: Database,
  plan: Pick<Phase7DocumentStoragePlan, "manifestVersion" | "moves">,
  generatedAt = new Date().toISOString(),
): Phase7DocumentStoragePlanVerification {
  const current = buildPhase7DocumentStoragePlan(db, generatedAt);
  const issues: Phase7DocumentStoragePlanVerification["issues"] = [];

  if (plan.manifestVersion !== 1) {
    issues.push({
      code: "invalid_manifest_version",
      detail: `Unsupported document storage plan manifestVersion ${String(plan.manifestVersion)}`,
    });
  }

  const targetKeys = new Set<string>();
  for (const move of plan.moves) {
    if (move.sourceKey === move.targetKey) {
      issues.push({
        code: "self_move",
        detail: `Document ${move.documentId} source and target keys are identical`,
      });
    }
    if (targetKeys.has(move.targetKey)) {
      issues.push({
        code: "duplicate_target_key",
        detail: `Multiple document moves target ${move.targetKey}`,
      });
    }
    targetKeys.add(move.targetKey);
  }

  if (current.issues.length > 0) {
    issues.push({
      code: "unsafe_current_rows",
      detail: `Current document storage audit has ${current.issues.length} issue(s)`,
    });
  }

  const expected = new Set(plan.moves.map(moveSignature));
  const actual = new Set(current.moves.map(moveSignature));
  const missing = [...expected].filter((signature) => !actual.has(signature));
  const extra = [...actual].filter((signature) => !expected.has(signature));
  if (missing.length > 0 || extra.length > 0) {
    issues.push({
      code: "move_plan_mismatch",
      detail: `Document storage plan does not match current DB state: missing ${missing.length}, extra ${extra.length}`,
    });
  }

  return {
    manifestVersion: 1,
    generatedAt,
    expectedMoveCount: plan.moves.length,
    currentMoveCount: current.moves.length,
    issues,
  };
}
