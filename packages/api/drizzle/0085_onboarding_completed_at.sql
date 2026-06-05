ALTER TABLE restaurants ADD COLUMN onboarding_completed_at TEXT;

-- Mark all existing restaurants as onboarded so the gate only fires for brand-new accounts.
UPDATE restaurants SET onboarding_completed_at = datetime('now') WHERE onboarding_completed_at IS NULL;
