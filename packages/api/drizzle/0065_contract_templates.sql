-- Contract templates — HCR convention collective boilerplates that owners can
-- edit per-restaurant. When null/empty, the API falls back to the built-in
-- default templates defined in services/contract-templates.ts.

CREATE TABLE IF NOT EXISTS contract_templates (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL CHECK (kind IN ('CDI', 'CDD', 'saisonnier', 'extra')),
  name TEXT NOT NULL,
  body_html TEXT NOT NULL,          -- mustache-style {{token}} substitution
  is_default INTEGER NOT NULL DEFAULT 0,  -- owner-marked "use this by default for the kind"
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS contract_templates_restaurant_idx
  ON contract_templates(restaurant_id, kind);
