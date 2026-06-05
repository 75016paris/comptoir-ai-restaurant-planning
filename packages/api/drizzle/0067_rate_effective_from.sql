-- Per-worker rate history — when the current hourly_rate / hcr_level became effective.
-- Used for historical cost accuracy (reporting, payroll replay).
-- hcr_level + hourly_rate already added by 0061_hcr_grid_and_hourly_rate.sql.

ALTER TABLE users ADD COLUMN rate_effective_from TEXT;
