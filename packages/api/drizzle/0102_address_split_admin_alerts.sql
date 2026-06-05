-- Split worker address into street + postal code + city for the public dossier
-- form (workers fill three short inputs instead of one long line). The legacy
-- `users.address` column is kept and continues to be written as the
-- concatenation `${street}, ${postalCode} ${city}` so existing read sites
-- (DPAE export, /staff list, etc.) keep working without changes.
ALTER TABLE users ADD COLUMN address_street TEXT;
ALTER TABLE users ADD COLUMN address_postal_code TEXT;
ALTER TABLE users ADD COLUMN address_city TEXT;

-- In-app admin notification queue. Surfaced as a toast/popup the next time the
-- admin opens the app — distinct from the outbound `notifications` table which
-- targets workers via WhatsApp/SMS. We don't piggy-back on that table because
-- channels and consumption semantics differ ("seen" vs "delivered").
CREATE TABLE admin_alerts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),    -- the admin/manager who should see this
  type TEXT NOT NULL,                                  -- e.g. "dossier_completed"
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT,                                     -- in-app link (e.g. /staff/<id>)
  worker_id TEXT REFERENCES users(id),                 -- subject of the alert when relevant
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);
CREATE INDEX admin_alerts_recipient_unseen_idx ON admin_alerts(recipient_id, seen_at);
