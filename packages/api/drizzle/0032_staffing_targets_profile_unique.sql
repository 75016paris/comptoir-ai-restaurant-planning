-- Recreate staffing_targets with profile_id in UNIQUE constraint
-- SQLite can't ALTER constraints, so we rebuild the table

CREATE TABLE staffing_targets_new (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT REFERENCES staffing_profiles(id),
  day_of_week INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('kitchen', 'server')),
  zone TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(restaurant_id, profile_id, day_of_week, role, zone)
);

INSERT INTO staffing_targets_new (id, restaurant_id, profile_id, day_of_week, role, zone, count)
SELECT id, restaurant_id, profile_id, day_of_week, role, zone, count
FROM staffing_targets;

DROP TABLE staffing_targets;
ALTER TABLE staffing_targets_new RENAME TO staffing_targets;
