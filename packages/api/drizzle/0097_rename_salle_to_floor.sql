-- Code/identifier consistency rename: 'salle' → 'floor' for role enum values
-- and the two restaurants columns that carry the term. The user-facing French
-- label "Salle" stays unchanged in the UI — only the code identifier flips.
--
-- Rationale: kitchen + admin + manager are English code identifiers; 'salle'
-- was the only French outlier in the role enum.

-- Role value updates on tables without SQL CHECK constraints
UPDATE users SET role = 'floor' WHERE role = 'salle';
UPDATE services SET role = 'floor' WHERE role = 'salle';
UPDATE service_templates SET role = 'floor' WHERE role = 'salle';

-- restaurants column renames
ALTER TABLE restaurants RENAME COLUMN salle_color TO floor_color;
ALTER TABLE restaurants RENAME COLUMN salle_sub_roles TO floor_sub_roles;

-- staffing_targets has a SQL-level CHECK(role IN ('kitchen', 'salle')) from
-- migration 0042. SQLite doesn't allow modifying CHECK constraints, so we
-- recreate the table with the new constraint.
PRAGMA foreign_keys = OFF;

CREATE TABLE "staffing_targets_new" (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT REFERENCES staffing_profiles(id),
  day_of_week INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('kitchen', 'floor')),
  zone TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  role_breakdown TEXT NOT NULL DEFAULT '{}',
  UNIQUE(restaurant_id, profile_id, day_of_week, role, zone)
);

INSERT INTO staffing_targets_new
  SELECT id, restaurant_id, profile_id, day_of_week,
         CASE WHEN role = 'salle' THEN 'floor' ELSE role END,
         zone, count, role_breakdown
  FROM staffing_targets;

DROP TABLE staffing_targets;
ALTER TABLE staffing_targets_new RENAME TO staffing_targets;

PRAGMA foreign_keys = ON;
PRAGMA wal_checkpoint(TRUNCATE);
