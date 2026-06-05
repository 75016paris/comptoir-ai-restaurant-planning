-- Worker-submitted requests to change their availability (permanent or temporary).
-- Owner must approve before any change is applied to worker_restrictions.
-- On approval: if kind='permanent', worker_restrictions is overwritten with the new set.
--              if kind='temporary', worker_restrictions rows are inserted with effective_from/until dates.

CREATE TABLE restriction_requests (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('permanent','temporary')),
  effective_from TEXT, -- YYYY-MM-DD, null for permanent
  effective_until TEXT, -- YYYY-MM-DD, null for permanent
  restrictions TEXT NOT NULL DEFAULT '[]', -- JSON: [{dayOfWeek, startTime, endTime, reason}]
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  note TEXT, -- worker's justification
  owner_note TEXT, -- owner's decision note
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_restriction_requests_restaurant ON restriction_requests(restaurant_id, status);
CREATE INDEX idx_restriction_requests_worker ON restriction_requests(worker_id, status);

-- Extend worker_restrictions with optional date range so temporary restrictions can apply only during a window.
ALTER TABLE worker_restrictions ADD COLUMN effective_from TEXT;
ALTER TABLE worker_restrictions ADD COLUMN effective_until TEXT;
