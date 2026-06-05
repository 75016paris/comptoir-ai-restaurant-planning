// Bun-native migration runner — applies all SQL files in order
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const dbPath = process.env.DATABASE_URL || "comptoir.db";
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Create migrations tracking table
db.exec(`
  CREATE TABLE IF NOT EXISTS __migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const applied = new Set(
  db.query("SELECT name FROM __migrations").all().map((r: any) => r.name)
);

const dir = join(import.meta.dir, "drizzle");
const baselineFile = join(dir, "baseline", "current.sql");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

function hasApplicationTables() {
  const rows = db.query(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> '__migrations'
  `).all();
  return rows.length > 0;
}

if (applied.size === 0 && !hasApplicationTables() && existsSync(baselineFile)) {
  db.exec(readFileSync(baselineFile, "utf8"));
  console.log("✓ baseline/current.sql");
}

const refreshedApplied = new Set(
  db.query("SELECT name FROM __migrations").all().map((r: any) => r.name)
);

let count = 0;
for (const file of files) {
  if (refreshedApplied.has(file)) continue;
  const sql = readFileSync(join(dir, file), "utf8");
  db.exec(sql);
  db.run("INSERT INTO __migrations (name) VALUES (?)", [file]);
  console.log(`✓ ${file}`);
  count++;
}

if (count === 0) console.log("Already up to date.");
else console.log(`Applied ${count} migration(s).`);

db.close();
