-- Staffing schedule — assign staffing profiles to specific weeks
CREATE TABLE IF NOT EXISTS staffing_schedule (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT NOT NULL REFERENCES staffing_profiles(id),
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  UNIQUE(restaurant_id, year, week)
);
