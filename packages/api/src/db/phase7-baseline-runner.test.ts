import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createPhase7BaselineDatabase,
  createPhase7BaselineSet,
} from "./phase7-baseline-runner";

function tablesIn(filePath: string) {
  const db = new Database(filePath, { readonly: true });
  try {
    return db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    db.close();
  }
}

describe("Phase 7 baseline runner", () => {
  test("creates a master baseline database in an isolated path", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-master-"));
    const filePath = join(dir, "master.sqlite");

    const result = createPhase7BaselineDatabase({ kind: "master", filePath });

    expect(result.kind).toBe("master");
    expect(result.filePath).toBe(filePath);
    expect(result.tables).toContain("login_identities");
    expect(result.tables).toContain("owners");
    expect(tablesIn(filePath)).toContain("sessions");
  });

  test("creates owner data baseline databases for each owner id", () => {
    const dir = mkdtempSync(join(tmpdir(), "comptoir-phase7-set-"));

    const result = createPhase7BaselineSet({
      directory: dir,
      owners: ["owner-a", "owner/b"],
    });

    expect(result.master.tables).toContain("login_identities");
    expect(result.ownerData).toHaveLength(2);
    expect(result.ownerData[0]?.tables).toContain("restaurants");
    expect(result.ownerData[0]?.tables).toContain("services");
    expect(result.ownerData[0]?.tables).not.toContain("password_reset_tokens");
    expect(tablesIn(join(dir, "owners", "owner-a", "comptoir.sqlite"))).toContain("documents");
    expect(tablesIn(join(dir, "owners", "owner%2Fb", "comptoir.sqlite"))).toContain("audit_logs");
  });
});

