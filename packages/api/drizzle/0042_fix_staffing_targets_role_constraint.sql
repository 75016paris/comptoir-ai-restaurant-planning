-- Fix staffing_targets CHECK constraint: 'server' → 'salle'
-- SQLite doesn't support ALTER COLUMN, so we recreate the table.
-- Migration 0041 updated users/services/service_templates correctly but
-- staffing_targets has CHECK(role IN ('kitchen','server')) which blocked the UPDATE.

PRAGMA foreign_keys = OFF;

CREATE TABLE "staffing_targets_new" (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT REFERENCES staffing_profiles(id),
  day_of_week INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('kitchen', 'salle')),
  zone TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(restaurant_id, profile_id, day_of_week, role, zone)
);

INSERT INTO staffing_targets_new
  SELECT id, restaurant_id, profile_id, day_of_week,
         CASE WHEN role = 'server' THEN 'salle' ELSE role END,
         zone, count
  FROM staffing_targets;

DROP TABLE staffing_targets;
ALTER TABLE staffing_targets_new RENAME TO staffing_targets;

PRAGMA foreign_keys = ON;
PRAGMA wal_checkpoint(TRUNCATE);
