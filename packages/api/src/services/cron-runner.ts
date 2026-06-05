// Phase A of the background-jobs strategy (id:67f8). Wraps a cron handler
// with bounded retry, persists each attempt to cron_runs, and serializes the
// result into the row so the Aide-tab UI can show last-run summaries.

import { db, rawDb } from "../db/connection.js";
import { cronRuns } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;

export interface RunCronOptions {
  maxAttempts?: number;
  backoffMs?: number;
  ownerId?: string | null;
  scope?: "fleet" | "owner";
}

export async function runCron<T>(
  jobName: string,
  handler: () => Promise<T>,
  opts: RunCronOptions = {},
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    const rowId = insertCronRun({
      jobName,
      attempt,
      status: "running",
      ownerId: opts.ownerId ?? null,
      scope: opts.scope ?? "fleet",
    });

    try {
      const result = await handler();
      const durationMs = Date.now() - startedAt;
      db.update(cronRuns)
        .set({
          status: "ok",
          finishedAt: new Date().toISOString(),
          durationMs,
          result: safeStringify(result),
        })
        .where(eq(cronRuns.id, rowId))
        .run();
      return { ok: true, result };
    } catch (err) {
      lastError = err;
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      db.update(cronRuns)
        .set({
          status: "error",
          finishedAt: new Date().toISOString(),
          durationMs,
          error: message.slice(0, 2000),
        })
        .where(eq(cronRuns.id, rowId))
        .run();

      if (attempt < maxAttempts) {
        await sleep(backoffMs * attempt);
      }
    }
  }

  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, error: finalMessage };
}

function cronRunColumnExists(column: string): boolean {
  const row = rawDb.query("PRAGMA table_info(cron_runs)").all()
    .find((entry) => (entry as { name?: string }).name === column);
  return !!row;
}

function insertCronRun(params: {
  jobName: string;
  attempt: number;
  status: "running" | "ok" | "error";
  ownerId: string | null;
  scope: "fleet" | "owner";
}): number {
  const columns = ["job_name", "attempt", "status"];
  const values: Array<string | number | null> = [params.jobName, params.attempt, params.status];
  if (cronRunColumnExists("owner_id")) {
    columns.push("owner_id");
    values.push(params.ownerId);
  }
  if (cronRunColumnExists("scope")) {
    columns.push("scope");
    values.push(params.scope);
  }
  const placeholders = columns.map(() => "?").join(", ");
  const result = rawDb.prepare(`INSERT INTO cron_runs (${columns.join(", ")}) VALUES (${placeholders})`).run(...values);
  return Number(result.lastInsertRowid);
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 4000 ? s.slice(0, 4000) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Latest run per known job, for the Aide-tab UI. Reads only the most recent
// row by started_at. Jobs that have never run won't appear.
export function getLatestCronRuns(): Array<{
  jobName: string;
  attempt: number;
  status: "running" | "ok" | "error";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: string | null;
}> {
  // Pull the most recent N rows then dedupe in code — SQLite's window-function
  // path would work too but this stays readable and fits a small table.
  const rows = db.select()
    .from(cronRuns)
    .orderBy(desc(cronRuns.startedAt), desc(cronRuns.id))
    .limit(200)
    .all();

  const seen = new Set<string>();
  const latest: typeof rows = [];
  for (const r of rows) {
    if (seen.has(r.jobName)) continue;
    seen.add(r.jobName);
    latest.push(r);
  }
  return latest.map((r) => ({
    jobName: r.jobName,
    attempt: r.attempt,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    error: r.error,
    result: r.result,
  }));
}
