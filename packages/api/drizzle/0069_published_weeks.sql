-- Published weeks tracking.
-- Schema was added in commit 28cc869 (2026-04-17) without a corresponding migration;
-- the /schedule/week/published endpoint has been 500'ing since then because the table
-- never existed on any deployed DB.

CREATE TABLE IF NOT EXISTS `published_weeks` (
  `id` text PRIMARY KEY NOT NULL,
  `restaurant_id` text NOT NULL REFERENCES `restaurants`(`id`),
  `week_date` text NOT NULL,
  `published_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS `published_weeks_resto_week_idx`
  ON `published_weeks` (`restaurant_id`, `week_date`);
