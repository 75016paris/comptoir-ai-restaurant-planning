CREATE TABLE `staffing_analysis_cache` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `restaurant_id` TEXT NOT NULL REFERENCES `restaurants`(`id`),
  `profile_id` TEXT,
  `horizon_weeks` INTEGER NOT NULL,
  `base_monday` TEXT NOT NULL,
  `cache_key` TEXT NOT NULL UNIQUE,
  `status` TEXT NOT NULL,
  `started_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `finished_at` TEXT,
  `duration_ms` INTEGER,
  `result` TEXT,
  `error` TEXT
);

CREATE INDEX `idx_staffing_analysis_cache_restaurant`
  ON `staffing_analysis_cache` (`restaurant_id`, `horizon_weeks`, `base_monday`);
