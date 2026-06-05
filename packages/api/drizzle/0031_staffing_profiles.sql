-- Staffing profiles — named sets of staffing targets
CREATE TABLE IF NOT EXISTS staffing_profiles (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add profile_id to staffing_targets (nullable for migration)
ALTER TABLE staffing_targets ADD COLUMN profile_id TEXT REFERENCES staffing_profiles(id);

-- Migrate existing targets: create a default profile per restaurant that has targets
-- We use a CTE-style approach with INSERT...SELECT
INSERT INTO staffing_profiles (id, restaurant_id, name, sort_order)
SELECT DISTINCT
  restaurant_id || '_default',
  restaurant_id,
  '',
  0
FROM staffing_targets
WHERE profile_id IS NULL;

-- Link existing targets to their default profile
UPDATE staffing_targets
SET profile_id = restaurant_id || '_default'
WHERE profile_id IS NULL
AND EXISTS (SELECT 1 FROM staffing_profiles WHERE id = staffing_targets.restaurant_id || '_default');
