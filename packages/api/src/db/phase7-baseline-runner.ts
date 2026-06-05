import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Phase7BaselineKind = "master" | "owner";

export type Phase7BaselineCreateInput = {
  kind: Phase7BaselineKind;
  filePath: string;
};

export type Phase7BaselineCreateResult = {
  kind: Phase7BaselineKind;
  filePath: string;
  tables: string[];
};

const apiRoot = join(import.meta.dir, "../..");

function baselineSqlPath(kind: Phase7BaselineKind) {
  const filename = kind === "master"
    ? "master/0000_master_baseline.sql"
    : "owner/0000_owner_baseline.sql";
  return join(apiRoot, "drizzle/phase7", filename);
}

function readBaselineSql(kind: Phase7BaselineKind) {
  return readFileSync(baselineSqlPath(kind), "utf8");
}

function listTables(db: Database) {
  return db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

export function createPhase7BaselineDatabase(input: Phase7BaselineCreateInput): Phase7BaselineCreateResult {
  mkdirSync(dirname(input.filePath), { recursive: true });

  const db = new Database(input.filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(readBaselineSql(input.kind));
    return {
      kind: input.kind,
      filePath: input.filePath,
      tables: listTables(db),
    };
  } finally {
    db.close();
  }
}

export function createPhase7BaselineSet(input: {
  directory: string;
  owners: readonly string[];
}) {
  const master = createPhase7BaselineDatabase({
    kind: "master",
    filePath: join(input.directory, "master.sqlite"),
  });

  const ownerData = input.owners.map((ownerId) => createPhase7BaselineDatabase({
    kind: "owner",
    filePath: join(input.directory, "owners", encodeURIComponent(ownerId), "comptoir.sqlite"),
  }));

  return { master, ownerData };
}

