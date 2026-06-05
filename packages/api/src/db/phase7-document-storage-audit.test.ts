import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildPhase7DocumentStoragePlan,
  collectPhase7DocumentStorageAudit,
  verifyPhase7DocumentStoragePlan,
  verifyPhase7DocumentStoragePostMove,
} from "./phase7-document-storage-audit";

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE restaurants (
      id text primary key,
      owner_id text
    );
    CREATE TABLE documents (
      id text primary key,
      restaurant_id text,
      user_id text,
      storage_provider text,
      storage_key text
    );
  `);
  return db;
}

describe("Phase 7 document storage audit", () => {
  test("accepts ready object keys scoped by restaurant and user", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES ('doc-a', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-a/users/worker-a/doc-a.pdf');
    `);

    expect(collectPhase7DocumentStorageAudit(db)).toEqual({
      totalDocuments: 1,
      objectDocuments: 1,
      sqliteDocuments: 0,
      readyObjectDocuments: 1,
      relocationMoves: [{
        documentId: "doc-a",
        sourceKey: "restaurants/resto-a/users/worker-a/doc-a.pdf",
        targetKey: "owners/owner-a/restaurants/resto-a/users/worker-a/doc-a.pdf",
      }],
      issues: [],
    });
  });

  test("accepts object keys already scoped for owner relocation", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES ('doc-a', 'resto-a', 'worker-a', 'ovh', 'owners/owner-a/restaurants/resto-a/users/worker-a/doc-a.pdf');
    `);

    expect(collectPhase7DocumentStorageAudit(db)).toEqual({
      totalDocuments: 1,
      objectDocuments: 1,
      sqliteDocuments: 0,
      readyObjectDocuments: 1,
      relocationMoves: [],
      issues: [],
    });
  });

  test("builds a deterministic offline relocation manifest", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES
        ('doc-a', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-a/users/worker-a/doc-a.pdf'),
        ('doc-sqlite', 'resto-a', 'worker-a', 'sqlite', NULL);
    `);

    expect(buildPhase7DocumentStoragePlan(db, "2026-05-25T00:00:00.000Z")).toEqual({
      manifestVersion: 1,
      generatedAt: "2026-05-25T00:00:00.000Z",
      totalDocuments: 2,
      objectDocuments: 1,
      readyObjectDocuments: 1,
      sqliteDocuments: 1,
      moveCount: 1,
      moves: [{
        documentId: "doc-a",
        sourceKey: "restaurants/resto-a/users/worker-a/doc-a.pdf",
        targetKey: "owners/owner-a/restaurants/resto-a/users/worker-a/doc-a.pdf",
      }],
      issues: [],
    });
  });

  test("post-move verification requires object keys to use owner-scoped paths", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES
        ('doc-moved', 'resto-a', 'worker-a', 'ovh', 'owners/owner-a/restaurants/resto-a/users/worker-a/doc-a.pdf'),
        ('doc-old', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-a/users/worker-a/doc-b.pdf');
    `);

    expect(verifyPhase7DocumentStoragePostMove(db, "2026-05-25T00:00:00.000Z")).toEqual({
      manifestVersion: 1,
      generatedAt: "2026-05-25T00:00:00.000Z",
      totalDocuments: 2,
      objectDocuments: 2,
      readyObjectDocuments: 2,
      sqliteDocuments: 0,
      issues: [{
        documentId: "doc-old",
        code: "unmoved_storage_key",
        detail: "Document doc-old key restaurants/resto-a/users/worker-a/doc-b.pdf has not moved to owners/owner-a/restaurants/resto-a/",
      }],
    });
  });

  test("verifies a relocation manifest against the current database state", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES ('doc-a', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-a/users/worker-a/doc-a.pdf');
    `);
    const plan = buildPhase7DocumentStoragePlan(db, "2026-05-25T00:00:00.000Z");

    expect(verifyPhase7DocumentStoragePlan(db, plan, "2026-05-25T00:01:00.000Z")).toEqual({
      manifestVersion: 1,
      generatedAt: "2026-05-25T00:01:00.000Z",
      expectedMoveCount: 1,
      currentMoveCount: 1,
      issues: [],
    });
  });

  test("rejects stale or unsafe relocation manifests", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a');
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES ('doc-a', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-a/users/worker-a/doc-a.pdf');
    `);

    const stalePlan = {
      manifestVersion: 1 as const,
      moves: [{
        documentId: "doc-a",
        sourceKey: "restaurants/resto-a/users/worker-a/doc-a.pdf",
        targetKey: "owners/owner-a/restaurants/resto-a/users/worker-a/doc-old.pdf",
      }],
    };

    expect(verifyPhase7DocumentStoragePlan(db, stalePlan, "2026-05-25T00:01:00.000Z").issues.map((issue) => issue.code)).toEqual([
      "move_plan_mismatch",
    ]);
  });

  test("reports object keys that cannot be safely moved by owner", () => {
    const db = createDb();
    db.exec(`
      INSERT INTO restaurants (id, owner_id) VALUES ('resto-a', 'owner-a'), ('resto-orphan', NULL);
      INSERT INTO documents (id, restaurant_id, user_id, storage_provider, storage_key)
      VALUES
        ('doc-missing', 'resto-a', 'worker-a', 'ovh', NULL),
        ('doc-pending', 'resto-a', 'worker-a', 'ovh', 'pending/doc-pending.pdf'),
        ('doc-restaurant', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-b/users/worker-a/doc.pdf'),
        ('doc-user', 'resto-a', 'worker-a', 'ovh', 'restaurants/resto-a/users/worker-b/doc.pdf'),
        ('doc-orphan', 'resto-orphan', 'worker-a', 'sqlite', NULL);
    `);

    const audit = collectPhase7DocumentStorageAudit(db);
    expect(audit.relocationMoves).toEqual([]);
    expect(audit.issues.map((issue) => issue.code)).toEqual([
      "missing_storage_key",
      "pending_storage_key",
      "restaurant_key_mismatch",
      "user_key_mismatch",
      "ownerless_restaurant",
    ]);
  });
});
