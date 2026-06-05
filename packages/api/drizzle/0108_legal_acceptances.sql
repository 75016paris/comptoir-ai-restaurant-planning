CREATE TABLE IF NOT EXISTS legal_acceptances (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  acceptance_type TEXT NOT NULL CHECK (acceptance_type IN ('owner_terms')),
  terms_version TEXT NOT NULL,
  dpa_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  subprocessors_version TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS legal_acceptances_restaurant_type_idx ON legal_acceptances(restaurant_id, acceptance_type);
CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_owner_terms_version_idx
  ON legal_acceptances(restaurant_id, acceptance_type, terms_version, dpa_version, privacy_version, subprocessors_version);
