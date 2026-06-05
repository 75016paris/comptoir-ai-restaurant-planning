CREATE TABLE worker_preferred_schedule (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  midi INTEGER NOT NULL DEFAULT 0,
  soir INTEGER NOT NULL DEFAULT 0
);
