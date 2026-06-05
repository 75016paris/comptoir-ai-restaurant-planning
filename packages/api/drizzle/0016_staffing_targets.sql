CREATE TABLE staffing_targets (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('kitchen', 'server')),
  zone TEXT NOT NULL CHECK(zone IN ('midi', 'soir')),
  count INTEGER NOT NULL DEFAULT 0
);
