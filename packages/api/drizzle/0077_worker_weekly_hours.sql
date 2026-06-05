-- Materialized per-worker per-week hours, used (eventually) to compute the
-- C9 rolling-average baseline without scanning `services` every solve.
--
-- Shipped behind the `USE_WEEKLY_HOURS_VIEW` env flag and currently populated
-- on-demand or via cron (follow-up task). The solver default remains the live
-- `services` scan until the view is validated.

CREATE TABLE `worker_weekly_hours` (
  `worker_id` text NOT NULL,
  `week_start` text NOT NULL,
  `hours_actual` real NOT NULL,
  `recorded_at` integer NOT NULL,
  `source` text NOT NULL DEFAULT 'services',
  PRIMARY KEY (`worker_id`, `week_start`)
);

CREATE INDEX `idx_worker_weekly_hours_worker` ON `worker_weekly_hours`(`worker_id`);
CREATE INDEX `idx_worker_weekly_hours_week` ON `worker_weekly_hours`(`week_start`);
