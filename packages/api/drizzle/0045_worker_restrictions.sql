-- Worker restrictions: time-slot based unavailability
-- Replaces zone-based worker_availability for scheduling decisions.
-- No restrictions = available everywhere (default).
-- A restriction with null start_time/end_time = full day block.

CREATE TABLE worker_restrictions (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,  -- 1=Mon, 7=Sun
  start_time TEXT,               -- HH:MM or NULL for full day
  end_time TEXT,                 -- HH:MM or NULL for full day
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_worker_restrictions_worker ON worker_restrictions(worker_id, restaurant_id);
