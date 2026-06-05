-- Phase A of the background-jobs strategy (id:67f8). One row per cron handler
-- attempt. The retry wrapper writes a 'running' row at start, then UPDATEs to
-- 'ok' or 'error' on completion. Failed runs that exhausted retries leave the
-- final 'error' row visible in the Aide-tab UI.

CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  result TEXT
);

CREATE INDEX idx_cron_runs_job_started ON cron_runs(job_name, started_at DESC);
