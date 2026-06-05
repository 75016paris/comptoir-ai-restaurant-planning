-- Calendar events: public holidays + school vacations per restaurant
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  type TEXT NOT NULL, -- 'public_holiday' | 'school_vacation'
  date TEXT NOT NULL, -- YYYY-MM-DD
  end_date TEXT, -- YYYY-MM-DD (vacations only)
  name TEXT NOT NULL,
  zone TEXT, -- 'metropole'/'alsace-moselle' or 'A'/'B'/'C'
  year INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_calendar_events_restaurant_date ON calendar_events(restaurant_id, date);

-- Zone columns on restaurants
ALTER TABLE restaurants ADD COLUMN school_zone TEXT; -- A/B/C
ALTER TABLE restaurants ADD COLUMN holiday_zone TEXT; -- metropole/alsace-moselle
