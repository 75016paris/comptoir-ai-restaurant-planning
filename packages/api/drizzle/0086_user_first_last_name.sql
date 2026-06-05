-- Split full name into first/last for proper HR forms.
-- Existing rows keep `name` populated; legacy data lands in `last_name` so display logic
-- (which still reads `name`) is untouched. New writes set all three.
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;

-- Backfill: copy full name into last_name. Heuristic split-on-space is risky for
-- French names (particles, compound first names), so leave first_name null and let
-- the UI prompt for it the next time the row is edited.
UPDATE users SET last_name = name WHERE last_name IS NULL;
