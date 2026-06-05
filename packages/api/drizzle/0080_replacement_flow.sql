-- Owner-mediated replacement flow.
-- swap_requests gains owner-decision and worker-reply states, candidate snapshot,
-- escalation tracking. target_service_id is dropped (two-way trade was never used).

ALTER TABLE swap_requests ADD COLUMN candidate_ids TEXT;
ALTER TABLE swap_requests ADD COLUMN candidate_scores TEXT;
ALTER TABLE swap_requests ADD COLUMN owner_notified_at TEXT;
ALTER TABLE swap_requests ADD COLUMN worker_notified_at TEXT;
ALTER TABLE swap_requests ADD COLUMN escalation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE swap_requests ADD COLUMN rejected_candidate_ids TEXT NOT NULL DEFAULT '[]';

-- SQLite can't ALTER COLUMN check constraints; the enum is enforced at the API
-- boundary (Drizzle text() with enum option). Existing pending rows are
-- backfilled to the new initial state so the bot routes them through review.
UPDATE swap_requests SET status = 'awaiting_owner_decision' WHERE status = 'pending';

-- Drop target_service_id (Drizzle 0.45 + SQLite require table rebuild for DROP COLUMN).
CREATE TABLE swap_requests_new (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id),
  requester_service_id TEXT NOT NULL REFERENCES services(id),
  target_id TEXT REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  status TEXT NOT NULL DEFAULT 'awaiting_owner_decision',
  message TEXT,
  responded_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  candidate_ids TEXT,
  candidate_scores TEXT,
  owner_notified_at TEXT,
  worker_notified_at TEXT,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  rejected_candidate_ids TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO swap_requests_new (
  id, requester_id, requester_service_id, target_id, restaurant_id, status,
  message, responded_at, expires_at, created_at,
  candidate_ids, candidate_scores, owner_notified_at, worker_notified_at,
  escalation_count, rejected_candidate_ids
)
SELECT
  id, requester_id, requester_service_id, target_id, restaurant_id, status,
  message, responded_at, expires_at, created_at,
  candidate_ids, candidate_scores, owner_notified_at, worker_notified_at,
  escalation_count, rejected_candidate_ids
FROM swap_requests;

DROP TABLE swap_requests;
ALTER TABLE swap_requests_new RENAME TO swap_requests;
