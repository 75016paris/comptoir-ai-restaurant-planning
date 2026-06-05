-- Remove CHECK constraint on staffing_targets.zone (was limited to midi/soir)
-- SQLite can't ALTER CHECK constraints, so recreate the table

CREATE TABLE staffing_targets_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('kitchen', 'server')),
  zone TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(restaurant_id, day_of_week, role, zone)
);

INSERT INTO staffing_targets_new (id, restaurant_id, day_of_week, role, zone, count)
SELECT id, restaurant_id, day_of_week, role, zone, count FROM staffing_targets;

DROP TABLE staffing_targets;
ALTER TABLE staffing_targets_new RENAME TO staffing_targets;
