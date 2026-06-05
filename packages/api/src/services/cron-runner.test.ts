import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "comptoir-cron-runner-test-")), "test.db");

const { rawDb } = await import("../db/connection.js");
const { runCron } = await import("./cron-runner.js");

function createCronRunsTable(extraColumns = true) {
  rawDb.exec(`
    DROP TABLE IF EXISTS cron_runs;
    CREATE TABLE cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      ${extraColumns ? "owner_id TEXT, scope TEXT," : ""}
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER,
      error TEXT,
      result TEXT
    );
  `);
}

beforeEach(() => {
  createCronRunsTable();
});

describe("cron runner scope metadata", () => {
  test("stores fleet scope by default when scope columns exist", async () => {
    const outcome = await runCron("planning-notifications", async () => ({ ok: true }));

    expect(outcome.ok).toBe(true);
    expect(rawDb.query("SELECT job_name, owner_id, scope, status FROM cron_runs").get()).toEqual({
      job_name: "planning-notifications",
      owner_id: null,
      scope: "fleet",
      status: "ok",
    });
  });

  test("stores owner scope when an owner job is requested", async () => {
    const outcome = await runCron("owner-local-job", async () => ({ ok: true }), {
      ownerId: "owner-a",
      scope: "owner",
    });

    expect(outcome.ok).toBe(true);
    expect(rawDb.query("SELECT owner_id, scope, status FROM cron_runs").get()).toEqual({
      owner_id: "owner-a",
      scope: "owner",
      status: "ok",
    });
  });

  test("keeps legacy cron_runs tables writable before migration 0121", async () => {
    createCronRunsTable(false);

    const outcome = await runCron("legacy-job", async () => ({ ok: true }));

    expect(outcome.ok).toBe(true);
    expect(rawDb.query("SELECT job_name, status FROM cron_runs").get()).toEqual({
      job_name: "legacy-job",
      status: "ok",
    });
  });
});
