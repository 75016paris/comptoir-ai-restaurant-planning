// Phase D of the OVH Object Storage migration.
//
//   for each documents row with storage_provider IS NULL and a non-empty data column:
//     decode base64 → putObject(key) → UPDATE storage_provider='ovh', storage_key=key
//
// Idempotent — re-running skips rows already on OVH. data column is left populated
// so Phase D is fully reversible (clear storage_provider back to NULL and the legacy
// read path resumes). Phase E nulls out the column once we're confident.
//
// Run:  bun packages/api/tools/internal/scripts/backfill-documents-to-ovh.ts [--dry-run] [--limit=N]
import { Database } from "bun:sqlite";
import { buildDocumentKey, getStorage } from "../../../src/services/storage";

const DB_PATH = process.env.DATABASE_URL || "comptoir.db";
const SLEEP_MS = Number(process.env.BACKFILL_SLEEP_MS ?? 50);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

if (getStorage().provider !== "ovh") {
  console.error("STORAGE_PROVIDER must be 'ovh' to run the backfill (got:", getStorage().provider + ")");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

const rows = db
  .query<
    {
      id: string;
      restaurant_id: string;
      user_id: string;
      filename: string;
      mime_type: string;
      data: string;
    },
    []
  >(
    `SELECT id, restaurant_id, user_id, filename, mime_type, data
       FROM documents
      WHERE storage_provider IS NULL
        AND data IS NOT NULL
        AND length(data) > 0
      ORDER BY created_at ASC`,
  )
  .all();

console.log(`Found ${rows.length} legacy row(s) to migrate (dry-run=${dryRun}, limit=${Number.isFinite(limit) ? limit : "∞"})`);

const update = db.prepare<unknown, [string, string, string]>(
  `UPDATE documents
      SET storage_provider = ?, storage_key = ?, storage_status = 'ready'
    WHERE id = ?`,
);

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  if (migrated >= limit) break;

  const buffer = Buffer.from(row.data, "base64");
  if (buffer.length === 0) {
    console.warn(`  [skip] ${row.id} → empty buffer after base64 decode`);
    skipped++;
    continue;
  }

  const key = buildDocumentKey({
    restaurantId: row.restaurant_id,
    userId: row.user_id,
    documentId: row.id,
    filename: row.filename,
  });

  if (dryRun) {
    console.log(`  [dry] ${row.id} → ${key} (${buffer.length} bytes)`);
    migrated++;
    continue;
  }

  try {
    await getStorage().putObject(key, buffer, row.mime_type);
    update.run("ovh", key, row.id);
    migrated++;
    if (migrated % 25 === 0) {
      console.log(`  ${migrated} / ${rows.length} done`);
    }
    if (SLEEP_MS > 0) await Bun.sleep(SLEEP_MS);
  } catch (err) {
    console.error(`  [fail] ${row.id} →`, err);
    failed++;
  }
}

console.log(
  `\n${dryRun ? "Would migrate" : "Migrated"} ${migrated} row(s)` +
    (skipped ? `, skipped ${skipped}` : "") +
    (failed ? `, failed ${failed}` : ""),
);
process.exit(failed > 0 ? 1 : 0);
