-- Open shifts — admin posts a vacant slot, eligible workers claim first-come via WhatsApp.
-- Distinct lifecycle from replacement_requests (which model "I'm dropping a confirmed shift").
-- An open shift has no requester — admin creates a vacant slot directly to cover surprise demand.
CREATE TABLE open_shifts (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,                      -- YYYY-MM-DD
  start_time TEXT NOT NULL,                -- HH:MM
  end_time TEXT NOT NULL,                  -- HH:MM
  role TEXT NOT NULL,                      -- kitchen | floor (validated app-side)
  required_sub_roles TEXT NOT NULL DEFAULT '[]',  -- JSON array
  message TEXT,                            -- admin context, e.g. "ce soir busy night"
  candidate_ids TEXT NOT NULL DEFAULT '[]',       -- JSON array (ranked at creation)
  rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',     -- open | claimed | cancelled | expired
  claimed_by TEXT REFERENCES users(id),
  claimed_at TEXT,
  service_id TEXT REFERENCES services(id), -- created on claim, NULL until then
  expires_at TEXT NOT NULL,                -- typically date+startTime
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_open_shifts_restaurant_status ON open_shifts(restaurant_id, status);
