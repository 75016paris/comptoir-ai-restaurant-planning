-- Last time we sent a "complete your dossier" reminder email to this worker.
-- Used by /cron/dossier-reminders to enforce a 3-day cadence so we don't
-- spam the worker on every cron tick.
ALTER TABLE users ADD COLUMN last_dossier_reminder_at TEXT;
